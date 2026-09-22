package wasmer_test

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	wasmer "go.wasmer.io/sdk"
)

func TestRegistryEdgeJS(t *testing.T) {
	if os.Getenv("WASMER_GO_INTEGRATION") != "1" || os.Getenv("WASMER_GO_NAPI") != "1" {
		t.Skip("set WASMER_GO_INTEGRATION=1 WASMER_GO_NAPI=1 on napi-v8 targets")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	w := client(t)
	pkg, err := w.Packages.Load("wasmer/edgejs@0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	server, err := os.ReadFile("testdata/edgejs-server.js")
	if err != nil {
		t.Fatal(err)
	}
	s, err := w.Sandboxes.Create(wasmer.SandboxOptions{Packages: []*wasmer.Package{pkg}, Files: map[string][]byte{"server.js": server}, Env: map[string]string{"PORT": fmt.Sprint(port)}, Network: wasmer.NetworkHost})
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.CommandPackage(pkg, "/workspace/server.js").Spawn(wasmer.SpawnOptions{Stdout: wasmer.OutputCapture, Stderr: wasmer.OutputCapture, Timeout: 45 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Ports.Wait(uint16(port), 30*time.Second); err != nil {
		p.Kill()
		out, _ := p.Wait()
		t.Fatalf("server did not start: %v\n%s", err, out.Stderr.Text())
	}
	response, err := (&http.Client{Timeout: 5 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/hello", port))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(body), "Hello from Edge.js!") {
		t.Fatalf("HTTP response: %d %s %v", response.StatusCode, body, err)
	}
	if err := p.Terminate(100 * time.Millisecond); err != nil {
		t.Fatal(err)
	}
	out, err := p.Wait()
	if err != nil || out.Reason != wasmer.Terminated {
		t.Fatalf("terminate: %+v %v", out, err)
	}
}

func TestRegistryPostgres(t *testing.T) {
	if os.Getenv("WASMER_GO_INTEGRATION") != "1" {
		t.Skip("set WASMER_GO_INTEGRATION=1 for registry workloads")
	}
	psql, err := exec.LookPath("psql")
	if err != nil {
		if os.Getenv("WASMER_GO_REQUIRE_PSQL") == "1" {
			t.Fatal("psql is required for release validation")
		}
		t.Skip("psql is required for the PostgreSQL integration test")
	}
	w := client(t)
	pkg, err := w.Packages.Load("wasmer/pglite@0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	s, err := w.Sandboxes.Create(wasmer.SandboxOptions{Packages: []*wasmer.Package{pkg}, Network: wasmer.NetworkHost})
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.CommandPackage(pkg).Spawn(wasmer.SpawnOptions{Stdout: wasmer.OutputCapture, Stderr: wasmer.OutputPipe, Timeout: 60 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(p.Stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "OLIPHAUNT_WASIX_SOCKET_READY 5432") {
				ready <- nil
				_, _ = io.Copy(io.Discard, p.Stderr)
				return
			}
		}
		ready <- fmt.Errorf("PostgreSQL exited before ready: %v", scanner.Err())
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("PostgreSQL did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := exec.CommandContext(ctx, psql, "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", "select version(), 40 + 2 as answer;").CombinedOutput()
	if err != nil || !strings.Contains(string(result), "wasm32-unknown-wasix") || !strings.Contains(string(result), "|42") {
		t.Fatalf("psql: %s %v", result, err)
	}
	out, err := p.Wait()
	if err != nil || !out.OK() {
		t.Fatalf("PostgreSQL exit: %+v %v", out, err)
	}
}
