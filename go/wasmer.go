// Package wasmer runs WASI/WASIX packages in native Wasmer sandboxes.
// Calls block the calling goroutine; independent operations may run concurrently.
// Close the client to shut down its sandboxes and release all native handles.
package wasmer

import (
	"errors"
	"fmt"
	"io"
	"time"

	ffi "go.wasmer.io/sdk/internal/ffi"
)

var ErrClosed = errors.New("wasmer: object or owning client is closed")

// Error is an SDK failure carrying a machine-readable code.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Code + ": " + e.Message }
func nativeError(err error) error {
	if err == nil {
		return nil
	}
	var failure *ffi.SdkErrorFailure
	if errors.As(err, &failure) {
		return &Error{Code: failure.Code, Message: failure.Message}
	}
	return err
}
func invalid(message string) error { return &Error{Code: "INVALID_ARGUMENT", Message: message} }

type Options struct {
	CacheRoot   string
	OutputBytes *uint64
}
type NetworkPolicy string

const (
	NetworkDisabled NetworkPolicy = "disabled"
	NetworkHost     NetworkPolicy = "host"
)

type ExitReason string

const (
	Exited     ExitReason = "exited"
	Terminated ExitReason = "terminated"
	Timeout    ExitReason = "timeout"
	Unknown    ExitReason = "unknown"
)

type CapturedOutput struct {
	Bytes     []byte
	Truncated bool
}

func (o CapturedOutput) Text() string { return string(o.Bytes) }

type Output struct {
	ExitCode       int32
	Reason         ExitReason
	Stdout, Stderr CapturedOutput
}

func (o Output) OK() bool { return o.ExitCode == 0 && o.Reason == Exited }
func (o Output) Check() error {
	if o.OK() {
		return nil
	}
	return &ProcessExitError{Output: o}
}
func (o Output) Text() (string, error) { return o.Stdout.Text(), o.Check() }

type ProcessExitError struct{ Output Output }

func (e *ProcessExitError) Error() string {
	return fmt.Sprintf("process %s (exit code %d): %s", e.Output.Reason, e.Output.ExitCode, e.Output.Stderr.Text())
}
func output(v ffi.ProcessOutput) Output {
	reason := map[ffi.ProcessExitReason]ExitReason{ffi.ProcessExitReasonExited: Exited, ffi.ProcessExitReasonTerminated: Terminated, ffi.ProcessExitReasonTimeout: Timeout}[v.Reason]
	if reason == "" {
		reason = Unknown
	}
	return Output{v.ExitCode, reason, CapturedOutput{v.Stdout, v.StdoutTruncated}, CapturedOutput{v.Stderr, v.StderrTruncated}}
}

type Wasmer struct {
	core      *ffi.WasmerCore
	life      *scope
	Packages  *Packages
	Sandboxes *Sandboxes
}
type Packages struct{ client *Wasmer }
type Sandboxes struct{ client *Wasmer }

func New(options Options) (*Wasmer, error) {
	var cache *string
	if options.CacheRoot != "" {
		cache = &options.CacheRoot
	}
	core, err := ffi.NewWasmerCore(ffi.ClientOptions{CacheRoot: cache, OutputBytes: options.OutputBytes})
	if err != nil {
		return nil, nativeError(err)
	}
	w := &Wasmer{core: core, life: newScope(nil, core.Close, core.Destroy)}
	w.Packages, w.Sandboxes = &Packages{w}, &Sandboxes{w}
	return w, nil
}
func (w *Wasmer) Close() error { return w.life.close() }

type PackageDefinition struct {
	Modules    map[string][]byte
	Commands   map[string]PackageCommandDefinition
	Entrypoint *string
	Files      map[string][]byte
}
type PackageCommandDefinition struct{ Module string }
type Package struct {
	core       *ffi.PackageCore
	life       *scope
	client     *Wasmer
	id         string
	commands   []string
	entrypoint *string
}

func wrapPackage(client *Wasmer, core *ffi.PackageCore) *Package {
	return &Package{core, newScope(client.life, nil, core.Destroy), client, core.Id(), core.Commands(), core.Entrypoint()}
}
func (p *Package) ID() string         { return p.id }
func (p *Package) Commands() []string { return append([]string(nil), p.commands...) }
func (p *Package) Entrypoint() (string, bool) {
	if p.entrypoint == nil {
		return "", false
	}
	return *p.entrypoint, true
}
func (p *Package) Close() error { return p.life.close() }

type CommandRef struct {
	pkg  *Package
	name string
}

func (p *Package) Command(name string) (*CommandRef, error) {
	done, err := p.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	ref, err := p.core.Command(name)
	if err != nil {
		return nil, nativeError(err)
	}
	ref.Destroy()
	return &CommandRef{p, name}, nil
}
func (p *Packages) load(fn func() (*ffi.PackageCore, error)) (*Package, error) {
	done, err := p.client.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	core, err := fn()
	if err != nil {
		return nil, nativeError(err)
	}
	return wrapPackage(p.client, core), nil
}
func (p *Packages) Load(specifier string) (*Package, error) {
	return p.load(func() (*ffi.PackageCore, error) { return p.client.core.LoadPackageRegistry(specifier) })
}
func (p *Packages) LoadPath(path string) (*Package, error) {
	return p.load(func() (*ffi.PackageCore, error) { return p.client.core.LoadPackagePath(path) })
}
func (p *Packages) LoadBytes(bytes []byte) (*Package, error) {
	return p.load(func() (*ffi.PackageCore, error) { return p.client.core.LoadPackageBytes(bytes) })
}
func (p *Packages) Create(definition PackageDefinition) (*Package, error) {
	commands := make(map[string]ffi.PackageCommandDefinition, len(definition.Commands))
	for name, command := range definition.Commands {
		commands[name] = ffi.PackageCommandDefinition{Module: command.Module}
	}
	return p.load(func() (*ffi.PackageCore, error) {
		return p.client.core.CreatePackage(ffi.PackageDefinition{Modules: definition.Modules, Commands: commands, Entrypoint: definition.Entrypoint, Files: definition.Files})
	})
}

type SandboxOptions struct {
	Packages []*Package
	Files    map[string][]byte
	Env      map[string]string
	Network  NetworkPolicy
}
type Sandbox struct {
	core   *ffi.SandboxCore
	life   *scope
	client *Wasmer
	FS     *FileSystem
	Ports  *Ports
}

func (s *Sandboxes) Create(options SandboxOptions) (*Sandbox, error) {
	done, err := s.client.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	network := ffi.NetworkModeDisabled
	if options.Network == NetworkHost {
		network = ffi.NetworkModeHost
	} else if options.Network != "" && options.Network != NetworkDisabled {
		return nil, invalid("unknown network policy")
	}
	packages := make([]*ffi.PackageCore, 0, len(options.Packages))
	for _, pkg := range options.Packages {
		if pkg == nil || pkg.client != s.client {
			return nil, invalid("packages must belong to this client")
		}
		release, err := pkg.life.enter()
		if err != nil {
			return nil, err
		}
		defer release()
		packages = append(packages, pkg.core)
	}
	core, err := s.client.core.CreateSandbox(packages, options.Files, options.Env, network)
	if err != nil {
		return nil, nativeError(err)
	}
	sandbox := &Sandbox{core: core, client: s.client, life: newScope(s.client.life, core.Close, core.Destroy)}
	sandbox.FS, sandbox.Ports = &FileSystem{sandbox}, &Ports{sandbox}
	return sandbox, nil
}
func (s *Sandbox) Close() error { return s.life.close() }
func (s *Sandbox) install(fn func() (*ffi.PackageCore, error)) (*Package, error) {
	done, err := s.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	core, err := fn()
	if err != nil {
		return nil, nativeError(err)
	}
	return wrapPackage(s.client, core), nil
}
func (s *Sandbox) Install(specifier string) (*Package, error) {
	return s.install(func() (*ffi.PackageCore, error) { return s.core.InstallPackageRegistry(specifier) })
}
func (s *Sandbox) InstallPath(path string) (*Package, error) {
	return s.install(func() (*ffi.PackageCore, error) { return s.core.InstallPackagePath(path) })
}
func (s *Sandbox) InstallBytes(bytes []byte) (*Package, error) {
	return s.install(func() (*ffi.PackageCore, error) { return s.core.InstallPackageBytes(bytes) })
}
func (s *Sandbox) InstallPackage(pkg *Package) (*Package, error) {
	if pkg == nil || pkg.client != s.client {
		return nil, invalid("package must belong to this client")
	}
	done, err := pkg.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	return s.install(func() (*ffi.PackageCore, error) { return s.core.InstallPackageRef(pkg.core) })
}

type CommandOptions struct {
	Dir string
	Env map[string]string
}
type Command struct {
	sandbox   *Sandbox
	name      string
	pkg       *Package
	reference *CommandRef
	args      []string
	options   CommandOptions
}

func (s *Sandbox) Command(name string, args ...string) *Command {
	return &Command{sandbox: s, name: name, args: append([]string(nil), args...)}
}
func (s *Sandbox) CommandPackage(pkg *Package, args ...string) *Command {
	return &Command{sandbox: s, pkg: pkg, args: append([]string(nil), args...)}
}
func (s *Sandbox) CommandRef(ref *CommandRef, args ...string) *Command {
	return &Command{sandbox: s, reference: ref, args: append([]string(nil), args...)}
}
func (c *Command) WithOptions(options CommandOptions) *Command {
	copy := *c
	copy.options = options
	copy.options.Env = make(map[string]string, len(options.Env))
	for k, v := range options.Env {
		copy.options.Env[k] = v
	}
	return &copy
}
func (c *Command) native() (*ffi.CommandCore, error) {
	var cwd *string
	if c.options.Dir != "" {
		cwd = &c.options.Dir
	}
	pkg := c.pkg
	if c.reference != nil {
		pkg = c.reference.pkg
	}
	if pkg != nil {
		if pkg.client != c.sandbox.client {
			return nil, invalid("command package must belong to this client")
		}
		done, err := pkg.life.enter()
		if err != nil {
			return nil, err
		}
		defer done()
		if c.reference != nil {
			ref, err := pkg.core.Command(c.reference.name)
			if err != nil {
				return nil, nativeError(err)
			}
			defer ref.Destroy()
			return c.sandbox.core.CommandRef(ref, c.args, cwd, c.options.Env), nil
		}
		return c.sandbox.core.CommandPackage(pkg.core, c.args, cwd, c.options.Env), nil
	}
	if c.name == "" {
		return nil, invalid("command name or package is required")
	}
	return c.sandbox.core.CommandName(c.name, c.args, cwd, c.options.Env), nil
}

type RunOptions struct {
	Input       []byte
	Timeout     time.Duration
	OutputBytes *uint64
	Unchecked   bool
}

func millis(duration time.Duration) (*uint64, error) {
	if duration < 0 {
		return nil, invalid("duration must not be negative")
	}
	if duration == 0 {
		return nil, nil
	}
	value := uint64(duration / time.Millisecond)
	if duration%time.Millisecond != 0 {
		value++
	}
	return &value, nil
}
func (c *Command) Run(options RunOptions) (Output, error) {
	timeout, err := millis(options.Timeout)
	if err != nil {
		return Output{}, err
	}
	done, err := c.sandbox.life.enter()
	if err != nil {
		return Output{}, err
	}
	defer done()
	core, err := c.native()
	if err != nil {
		return Output{}, err
	}
	defer core.Destroy()
	var input *[]byte
	if options.Input != nil {
		input = &options.Input
	}
	v, err := core.Run(ffi.RunOptions{Input: input, TimeoutMs: timeout, OutputBytes: options.OutputBytes})
	if err != nil {
		return Output{}, nativeError(err)
	}
	out := output(v)
	if !options.Unchecked {
		return out, out.Check()
	}
	return out, nil
}

type InputMode string

const (
	InputClosed InputMode = "closed"
	InputPipe   InputMode = "pipe"
)

type OutputMode string

const (
	OutputPipe    OutputMode = "pipe"
	OutputCapture OutputMode = "capture"
	OutputDiscard OutputMode = "discard"
)

type SpawnOptions struct {
	Timeout        time.Duration
	OutputBytes    *uint64
	Stdin          InputMode
	Stdout, Stderr OutputMode
}

func outputMode(mode OutputMode) (ffi.OutputMode, error) {
	switch mode {
	case "", OutputPipe:
		return ffi.OutputModePipe, nil
	case OutputCapture:
		return ffi.OutputModeCapture, nil
	case OutputDiscard:
		return ffi.OutputModeDiscard, nil
	default:
		return 0, invalid("unknown output mode")
	}
}
func (c *Command) Spawn(options SpawnOptions) (*Process, error) {
	timeout, err := millis(options.Timeout)
	if err != nil {
		return nil, err
	}
	stdin := ffi.InputModeClosed
	if options.Stdin == InputPipe {
		stdin = ffi.InputModePipe
	} else if options.Stdin != "" && options.Stdin != InputClosed {
		return nil, invalid("unknown input mode")
	}
	stdout, err := outputMode(options.Stdout)
	if err != nil {
		return nil, err
	}
	stderr, err := outputMode(options.Stderr)
	if err != nil {
		return nil, err
	}
	done, err := c.sandbox.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	command, err := c.native()
	if err != nil {
		return nil, err
	}
	defer command.Destroy()
	core, err := command.Spawn(ffi.SpawnOptions{TimeoutMs: timeout, OutputBytes: options.OutputBytes, Stdin: stdin, Stdout: stdout, Stderr: stderr})
	if err != nil {
		return nil, nativeError(err)
	}
	p := &Process{core: core, id: core.Id()}
	p.life = newScope(c.sandbox.life, func() error { core.Kill(); _, err := core.Wait(); return err }, core.Destroy)
	if core.HasStdin() {
		p.Stdin = &processWriter{p}
	}
	if core.HasStdout() {
		p.Stdout = &processReader{process: p}
	}
	if core.HasStderr() {
		p.Stderr = &processReader{process: p, stderr: true}
	}
	return p, nil
}

type Process struct {
	core           *ffi.ProcessCore
	life           *scope
	id             uint32
	Stdin          io.WriteCloser
	Stdout, Stderr io.Reader
}

func (p *Process) ID() uint32   { return p.id }
func (p *Process) Close() error { return p.life.close() }
func (p *Process) Wait() (Output, error) {
	done, err := p.life.enter()
	if err != nil {
		return Output{}, err
	}
	defer done()
	v, err := p.core.Wait()
	if err != nil {
		return Output{}, nativeError(err)
	}
	return output(v), nil
}
func (p *Process) Kill() error {
	done, err := p.life.enter()
	if err != nil {
		return err
	}
	defer done()
	p.core.Kill()
	return nil
}
func (p *Process) Terminate(grace time.Duration) error {
	ms, err := millis(grace)
	if err != nil {
		return err
	}
	var value uint64
	if ms != nil {
		value = *ms
	}
	done, err := p.life.enter()
	if err != nil {
		return err
	}
	defer done()
	return nativeError(p.core.Terminate(value))
}

type processReader struct {
	process *Process
	stderr  bool
}

func (r *processReader) Read(bytes []byte) (int, error) {
	if len(bytes) == 0 {
		return 0, nil
	}
	done, err := r.process.life.enter()
	if err != nil {
		return 0, err
	}
	defer done()
	size := min(len(bytes), 64*1024)
	var chunk *[]byte
	if r.stderr {
		chunk, err = r.process.core.ReadStderr(uint64(size))
	} else {
		chunk, err = r.process.core.ReadStdout(uint64(size))
	}
	if err != nil {
		return 0, nativeError(err)
	}
	if chunk == nil {
		return 0, io.EOF
	}
	return copy(bytes, *chunk), nil
}

type processWriter struct{ process *Process }

func (w *processWriter) Write(bytes []byte) (int, error) {
	done, err := w.process.life.enter()
	if err != nil {
		return 0, err
	}
	defer done()
	if err := w.process.core.WriteStdin(bytes); err != nil {
		return 0, nativeError(err)
	}
	return len(bytes), nil
}
func (w *processWriter) Close() error {
	done, err := w.process.life.enter()
	if err != nil {
		return err
	}
	defer done()
	return nativeError(w.process.core.CloseStdin())
}

type FileSystem struct{ sandbox *Sandbox }
type FileKind string

const (
	File      FileKind = "file"
	Directory FileKind = "directory"
)

type FileStat struct {
	Kind FileKind
	Size uint64
}
type DirectoryEntry struct {
	Name string
	Kind FileKind
	Size uint64
}

func kind(v ffi.FileKind) FileKind {
	if v == ffi.FileKindDirectory {
		return Directory
	}
	return File
}
func fsCall[T any](fs *FileSystem, fn func(*ffi.FileSystemCore) (T, error)) (T, error) {
	var zero T
	done, err := fs.sandbox.life.enter()
	if err != nil {
		return zero, err
	}
	defer done()
	core := fs.sandbox.core.Filesystem()
	defer core.Destroy()
	value, err := fn(core)
	return value, nativeError(err)
}
func (fs *FileSystem) Read(path string) ([]byte, error) {
	return fsCall(fs, func(c *ffi.FileSystemCore) ([]byte, error) { return c.Read(path) })
}
func (fs *FileSystem) Write(path string, bytes []byte) error {
	_, err := fsCall(fs, func(c *ffi.FileSystemCore) (bool, error) { return true, c.Write(path, bytes) })
	return err
}
func (fs *FileSystem) Mkdir(path string, recursive bool) error {
	_, err := fsCall(fs, func(c *ffi.FileSystemCore) (bool, error) { return true, c.Mkdir(path, recursive) })
	return err
}
func (fs *FileSystem) Remove(path string, recursive bool) error {
	_, err := fsCall(fs, func(c *ffi.FileSystemCore) (bool, error) { return true, c.Remove(path, recursive) })
	return err
}
func (fs *FileSystem) Rename(from, to string) error {
	_, err := fsCall(fs, func(c *ffi.FileSystemCore) (bool, error) { return true, c.Rename(from, to) })
	return err
}
func (fs *FileSystem) Stat(path string) (FileStat, error) {
	v, err := fsCall(fs, func(c *ffi.FileSystemCore) (ffi.FileStat, error) { return c.Stat(path) })
	return FileStat{kind(v.Kind), v.Size}, err
}
func (fs *FileSystem) ReadDir(path string) ([]DirectoryEntry, error) {
	v, err := fsCall(fs, func(c *ffi.FileSystemCore) ([]ffi.DirectoryEntry, error) { return c.ReadDir(path) })
	if err != nil {
		return nil, err
	}
	entries := make([]DirectoryEntry, len(v))
	for i, e := range v {
		entries[i] = DirectoryEntry{e.Name, kind(e.Kind), e.Size}
	}
	return entries, nil
}

type Ports struct{ sandbox *Sandbox }

func (p *Ports) Wait(port uint16, timeout time.Duration) error {
	ms, err := millis(timeout)
	if err != nil {
		return err
	}
	if ms == nil {
		return invalid("port timeout must be positive")
	}
	done, err := p.sandbox.life.enter()
	if err != nil {
		return err
	}
	defer done()
	core := p.sandbox.core.Ports()
	defer core.Destroy()
	return nativeError(core.Wait(port, *ms))
}
