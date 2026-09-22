// wasmer-sdk installs native release archives and configures cgo build commands.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"go.wasmer.io/sdk/internal/distribution"
	"go.wasmer.io/sdk/internal/installer"
)

func selectedVersion(manifest distribution.Manifest) error {
	cmd := exec.Command("go", "list", "-m", "-json", manifest.Module)
	b, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("add %s@v%s to the application's go.mod first: %w", manifest.Module, manifest.Version, err)
	}
	var module struct {
		Version string
		Main    bool
		Replace *json.RawMessage
	}
	if err := json.Unmarshal(b, &module); err != nil {
		return err
	}
	if module.Replace != nil {
		return errors.New("native helper requires a released module without a replace directive; use go/scripts/test.py for source development")
	}
	if module.Version != "v"+manifest.Version {
		return fmt.Errorf("helper v%s differs from selected SDK %s", manifest.Version, module.Version)
	}
	return nil
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: wasmer-sdk install|env|exec [--link static|dynamic] [--archive FILE] [-- COMMAND...]")
	}
	command := os.Args[1]
	if command != "install" && command != "env" && command != "exec" {
		return errors.New("expected install, env or exec")
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	link := flags.String("link", "static", "native SDK linkage: static or dynamic")
	archive := flags.String("archive", "", "install an already downloaded release archive")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	if *link != "static" && *link != "dynamic" {
		return errors.New("link must be static or dynamic")
	}
	if command == "exec" && len(flags.Args()) == 0 {
		return errors.New("exec requires a command after --")
	}
	if command != "exec" && len(flags.Args()) != 0 {
		return errors.New("unexpected positional arguments")
	}
	manifest, err := distribution.Load()
	if err != nil {
		return err
	}
	if manifest.Version == "development" {
		return errors.New("this source checkout has no published native manifest; build locally with go/scripts/build.py")
	}
	if err := selectedVersion(manifest); err != nil {
		return err
	}
	goenv, err := exec.Command("go", "env", "GOOS", "GOARCH").Output()
	if err != nil {
		return err
	}
	parts := strings.Fields(string(goenv))
	if len(parts) != 2 {
		return errors.New("cannot determine Go target")
	}
	target := strings.Join(parts, "-")
	cache := os.Getenv("WASMER_SDK_NATIVE_CACHE")
	if cache == "" {
		cache, err = os.UserCacheDir()
		if err != nil {
			return err
		}
		cache = filepath.Join(cache, "wasmer-sdk", "native")
	}
	cache, err = filepath.Abs(cache)
	if err != nil {
		return err
	}
	var directory string
	if command == "install" {
		directory, err = installer.Install(context.Background(), manifest, target, cache, *archive)
		if err == nil {
			fmt.Println(directory)
		}
		return err
	}
	directory, err = installer.Directory(cache, manifest, target)
	if err != nil {
		return err
	}
	native, err := installer.Verify(directory, manifest, target)
	if err != nil {
		return fmt.Errorf("native SDK is unavailable or modified; run the matching helper's install command: %w", err)
	}
	quote := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	ldflags := quote(filepath.Join(directory, "static", "libwasmer_sdk_uniffi.a")) + " " + native.StaticLinkFlags
	if *link == "dynamic" {
		library := filepath.Join(directory, "dynamic")
		ldflags = quote("-L"+library) + " -lwasmer_sdk_uniffi " + quote("-Wl,-rpath,"+library)
	}
	if existing := os.Getenv("CGO_LDFLAGS"); existing != "" {
		ldflags += " " + existing
	}
	if command == "env" {
		shellQuote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
		fmt.Printf("export CGO_ENABLED=1\nexport CGO_LDFLAGS=%s\n", shellQuote(ldflags))
		return nil
	}
	child := exec.Command(flags.Args()[0], flags.Args()[1:]...)
	child.Env = append(os.Environ(), "CGO_ENABLED=1", "CGO_LDFLAGS="+ldflags)
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	return child.Run()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
