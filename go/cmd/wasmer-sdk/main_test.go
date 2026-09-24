package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.wasmer.io/sdk/internal/distribution"
)

func TestSelectedVersionRespectsWorkspace(t *testing.T) {
	directory := t.TempDir()
	consumer := filepath.Join(directory, "consumer")
	sdk := filepath.Join(directory, "sdk")
	for _, path := range []string{consumer, sdk} {
		if err := os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(consumer, "go.mod"):   "module example.org/consumer\n\ngo 1.26.0\n\nrequire go.wasmer.io/sdk v0.1.0\n",
		filepath.Join(sdk, "go.mod"):        "module go.wasmer.io/sdk\n\ngo 1.26.0\n",
		filepath.Join(directory, "go.work"): "go 1.26.0\n\nuse (\n ./consumer\n ./sdk\n)\n",
	}
	for path, contents := range files {
		if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(consumer)
	t.Setenv("GOTOOLCHAIN", "local")
	t.Setenv("GOPROXY", "off")
	t.Setenv("GOSUMDB", "off")
	t.Setenv("GOWORK", filepath.Join(directory, "go.work"))
	manifest := distribution.Manifest{Module: "go.wasmer.io/sdk", Version: "0.1.0"}
	if err := selectedVersion(manifest); err == nil || !strings.Contains(err.Error(), "differs from selected SDK") {
		t.Fatalf("workspace SDK must not silently use a release's native libraries: %v", err)
	}
}
