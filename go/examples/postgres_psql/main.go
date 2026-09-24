package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	wasmer "go.wasmer.io/sdk"
	"go.wasmer.io/sdk/examples/internal/guest"
)

func run(psql string) error {
	path, err := exec.LookPath(psql)
	if err != nil {
		return fmt.Errorf("install the native psql client or pass --psql: %w", err)
	}
	client, err := wasmer.New(wasmer.Options{})
	if err != nil {
		return err
	}
	defer client.Close()
	postgres, err := client.Packages.Load("wasmer/pglite@0.1.0")
	if err != nil {
		return err
	}
	sandbox, err := client.Sandboxes.Create(wasmer.SandboxOptions{
		Packages: []*wasmer.Package{postgres}, Network: wasmer.NetworkHost,
	})
	if err != nil {
		return err
	}
	defer sandbox.Close()
	process, err := sandbox.Command("pglite").Spawn(wasmer.SpawnOptions{
		Stdout: wasmer.OutputCapture, Stderr: wasmer.OutputPipe, Timeout: 60 * time.Second,
	})
	if err != nil {
		return err
	}
	defer process.Close()
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(process.Stderr)
		for scanner.Scan() {
			fmt.Fprintln(os.Stderr, scanner.Text())
			if strings.Contains(scanner.Text(), "OLIPHAUNT_WASIX_SOCKET_READY 5432") {
				ready <- nil
				_, _ = io.Copy(io.Discard, process.Stderr)
				return
			}
		}
		ready <- fmt.Errorf("PostgreSQL exited before it was ready: %v", scanner.Err())
	}()
	select {
	case err := <-ready:
		if err != nil {
			return err
		}
	case <-time.After(30 * time.Second):
		return fmt.Errorf("PostgreSQL did not start on port 5432")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	query := exec.CommandContext(ctx, path, "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable",
		"-X", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-")
	query.Stdin = strings.NewReader(guest.PostgresSQL)
	result, err := query.CombinedOutput()
	if err != nil {
		return fmt.Errorf("psql: %w\n%s", err, result)
	}
	fmt.Println(strings.TrimSpace(string(result)))
	output, err := process.Wait()
	if err != nil {
		return err
	}
	return output.Check()
}

func main() {
	psql := flag.String("psql", "psql", "path to the native PostgreSQL client")
	flag.Parse()
	if err := run(*psql); err != nil {
		log.Fatal(err)
	}
}
