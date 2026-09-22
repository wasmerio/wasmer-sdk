package wasmer_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	wasmer "go.wasmer.io/sdk"
)

func client(t *testing.T) *wasmer.Wasmer {
	t.Helper()
	w, err := wasmer.New(wasmer.Options{CacheRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	return w
}
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name + ".wasm")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func sandbox(t *testing.T, w *wasmer.Wasmer, name string) *wasmer.Sandbox {
	t.Helper()
	pkg, err := w.Packages.LoadBytes(fixture(t, name))
	if err != nil {
		t.Fatal(err)
	}
	s, err := w.Sandboxes.Create(wasmer.SandboxOptions{Packages: []*wasmer.Package{pkg}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPackageDefinitionAndFilesystem(t *testing.T) {
	w := client(t)
	pkg, err := w.Packages.Create(wasmer.PackageDefinition{Modules: map[string][]byte{"hello": fixture(t, "hello")}, Commands: map[string]wasmer.PackageCommandDefinition{"hello": {Module: "hello"}}, Files: map[string][]byte{"/asset.txt": []byte("asset")}})
	if err != nil {
		t.Fatal(err)
	}
	if name, ok := pkg.Entrypoint(); !ok || name != "hello" {
		t.Fatalf("entrypoint %q %v", name, ok)
	}
	s, err := w.Sandboxes.Create(wasmer.SandboxOptions{Packages: []*wasmer.Package{pkg}, Files: map[string][]byte{"test.txt": []byte("hello")}})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := pkg.Command("hello")
	if err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []*wasmer.Command{s.Command("hello"), s.CommandPackage(pkg), s.CommandRef(ref)} {
		out, err := cmd.Run(wasmer.RunOptions{})
		if err != nil || !strings.Contains(out.Stdout.Text(), "Hello from Swift!") {
			t.Fatalf("run: %+v %v", out, err)
		}
	}
	if err := s.FS.Mkdir("nested", true); err != nil {
		t.Fatal(err)
	}
	if err := s.FS.Write("nested/original", []byte{}); err != nil {
		t.Fatal(err)
	}
	if err := s.FS.Rename("nested/original", "nested/renamed"); err != nil {
		t.Fatal(err)
	}
	b, err := s.FS.Read("nested/renamed")
	if err != nil || len(b) != 0 {
		t.Fatalf("empty read: %v %v", b, err)
	}
	entries, err := s.FS.ReadDir("nested")
	if err != nil || len(entries) != 1 || entries[0].Name != "renamed" {
		t.Fatalf("read dir: %v %v", entries, err)
	}
	stat, err := s.FS.Stat("nested")
	if err != nil || stat.Kind != wasmer.Directory {
		t.Fatalf("stat: %v %v", stat, err)
	}
	if err := s.FS.Remove("nested", true); err != nil {
		t.Fatal(err)
	}
	_, err = s.FS.Read("missing")
	var sdkError *wasmer.Error
	if !errors.As(err, &sdkError) || sdkError.Code == "" {
		t.Fatalf("expected SDK error, got %v", err)
	}
}

func TestStreamsEOFAndCheckedExit(t *testing.T) {
	w := client(t)
	s := sandbox(t, w, "echo")
	p, err := s.Command("main").Spawn(wasmer.SpawnOptions{Stdin: wasmer.InputPipe, Stderr: wasmer.OutputDiscard})
	if err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("hello\n"), 100)
	if _, err := p.Stdin.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := p.Stdin.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(p.Stdout)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("echo: len=%d %v", len(got), err)
	}
	out, err := p.Wait()
	if err != nil || !out.OK() {
		t.Fatalf("wait: %v %v", out, err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = p.Wait()
	if !errors.Is(err, wasmer.ErrClosed) {
		t.Fatalf("after close: %v", err)
	}
	fail := sandbox(t, w, "fail")
	out, err = fail.Command("main").Run(wasmer.RunOptions{})
	var exit *wasmer.ProcessExitError
	if !errors.As(err, &exit) || out.ExitCode != 7 {
		t.Fatalf("checked failure: %v %v", out, err)
	}
	out, err = fail.Command("main").Run(wasmer.RunOptions{Unchecked: true})
	if err != nil || out.ExitCode != 7 {
		t.Fatalf("unchecked failure: %v %v", out, err)
	}
	_, err = s.Command("main").Run(wasmer.RunOptions{Timeout: -1})
	if err == nil {
		t.Fatal("negative timeout accepted")
	}
}

func TestTimeoutAndConcurrentClose(t *testing.T) {
	w := client(t)
	s := sandbox(t, w, "echo")
	p, err := s.Command("main").Spawn(wasmer.SpawnOptions{Stdin: wasmer.InputPipe, Stdout: wasmer.OutputDiscard, Stderr: wasmer.OutputDiscard, Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	out, err := p.Wait()
	if err != nil || out.Reason != wasmer.Timeout {
		t.Fatalf("timeout: %v %v", out, err)
	}
	p, err = s.Command("main").Spawn(wasmer.SpawnOptions{Stdin: wasmer.InputPipe, Stderr: wasmer.OutputDiscard})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	go func() { close(started); _, _ = io.ReadAll(p.Stdout); close(finished) }()
	<-started
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if err := w.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("read did not unblock on close")
	}
	_, err = s.FS.Read("x")
	if !errors.Is(err, wasmer.ErrClosed) {
		t.Fatalf("parent close: %v", err)
	}
}

func TestRegistryPython(t *testing.T) {
	if os.Getenv("WASMER_GO_INTEGRATION") != "1" {
		t.Skip("set WASMER_GO_INTEGRATION=1 for registry workloads")
	}
	w := client(t)
	pkg, err := w.Packages.Load("python/python@=3.13.20")
	if err != nil {
		t.Fatal(err)
	}
	s, err := w.Sandboxes.Create(wasmer.SandboxOptions{Packages: []*wasmer.Package{pkg}})
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Command("python", "-c", "print('hello from Go')").Run(wasmer.RunOptions{Timeout: 30 * time.Second})
	if err != nil || strings.TrimSpace(out.Stdout.Text()) != "hello from Go" {
		t.Fatalf("python: %v %v", out, err)
	}
}
