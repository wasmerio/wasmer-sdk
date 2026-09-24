package main

import (
	"fmt"
	"log"
	"strings"
	"time"

	wasmer "go.wasmer.io/sdk"
	"go.wasmer.io/sdk/examples/internal/guest"
)

func run() error {
	client, err := wasmer.New(wasmer.Options{})
	if err != nil {
		return err
	}
	defer client.Close()
	python, err := client.Packages.Load("python/python@=3.13.20")
	if err != nil {
		return err
	}
	sandbox, err := client.Sandboxes.Create(wasmer.SandboxOptions{
		Packages: []*wasmer.Package{python},
		Files:    map[string][]byte{"hello.py": guest.Python},
	})
	if err != nil {
		return err
	}
	defer sandbox.Close()
	output, err := sandbox.Command("python", "/workspace/hello.py").Run(wasmer.RunOptions{Timeout: 30 * time.Second})
	if err != nil {
		return err
	}
	fmt.Println(strings.TrimSpace(output.Stdout.Text()))
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
