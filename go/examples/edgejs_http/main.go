package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"time"

	wasmer "go.wasmer.io/sdk"
	"go.wasmer.io/sdk/examples/internal/guest"
)

func run() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return err
	}
	client, err := wasmer.New(wasmer.Options{})
	if err != nil {
		return err
	}
	defer client.Close()
	edge, err := client.Packages.Load("wasmer/edgejs@0.2.0")
	if err != nil {
		return err
	}
	sandbox, err := client.Sandboxes.Create(wasmer.SandboxOptions{
		Packages: []*wasmer.Package{edge},
		Files:    map[string][]byte{"server.js": guest.EdgeJS},
		Env:      map[string]string{"PORT": fmt.Sprint(port)},
		Network:  wasmer.NetworkHost,
	})
	if err != nil {
		return err
	}
	defer sandbox.Close()
	process, err := sandbox.Command("edge", "/workspace/server.js").Spawn(wasmer.SpawnOptions{
		Stdout: wasmer.OutputCapture, Stderr: wasmer.OutputCapture, Timeout: 45 * time.Second,
	})
	if err != nil {
		return err
	}
	defer process.Close()
	if err := sandbox.Ports.Wait(uint16(port), 30*time.Second); err != nil {
		return err
	}
	httpClient := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := httpClient.Get(fmt.Sprintf("http://127.0.0.1:%d/hello", port))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	fmt.Printf("GET /hello -> %d\n%s\n", response.StatusCode, body)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP status: %s", response.Status)
	}
	if err := process.Terminate(2 * time.Second); err != nil {
		return err
	}
	_, err = process.Wait()
	return err
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
