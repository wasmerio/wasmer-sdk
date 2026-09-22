package main

import (
	"fmt"
	"log"
	"strings"
	"time"

	wasmer "go.wasmer.io/sdk"
)

func run() error {
	client, err := wasmer.New(wasmer.Options{})
	if err != nil {
		return err
	}
	defer client.Close()
	var packages []*wasmer.Package
	for _, name := range []string{"python/python@=3.13.20", "wasmer/edgejs@0.2.0", "php/php-32"} {
		pkg, err := client.Packages.Load(name)
		if err != nil {
			return err
		}
		packages = append(packages, pkg)
	}
	sandbox, err := client.Sandboxes.Create(wasmer.SandboxOptions{Packages: packages})
	if err != nil {
		return err
	}
	defer sandbox.Close()
	commands := []struct {
		pkg  *wasmer.Package
		name string
		args []string
	}{
		{packages[0], "echo", []string{"hello from shell tools"}},
		{packages[0], "python", []string{"-c", "print('hello from Python')"}},
		{packages[1], "edge", []string{"-e", `console.log("hello from Edge.js")`}},
		{packages[2], "php", []string{"-r", "echo 'hello from PHP';"}},
	}
	for _, command := range commands {
		// Several runtimes provide shell commands such as echo. Select the
		// package explicitly so overlapping command names are unambiguous.
		reference, err := command.pkg.Command(command.name)
		if err != nil {
			return err
		}
		output, err := sandbox.CommandRef(reference, command.args...).Run(wasmer.RunOptions{Timeout: 30 * time.Second})
		if err != nil {
			return err
		}
		fmt.Println(strings.TrimSpace(output.Stdout.Text()))
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
