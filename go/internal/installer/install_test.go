package installer

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"go.wasmer.io/sdk/internal/distribution"
)

func archiveFixture(t *testing.T, extra *tar.Header) (distribution.Manifest, string) {
	t.Helper()
	manifest := distribution.Manifest{Schema: 1, Module: "go.wasmer.io/sdk", Version: "0.1.0", SourceSHA: strings.Repeat("a", 40)}
	native, _ := json.Marshal(Native{Schema: 1, Version: manifest.Version, SourceSHA: manifest.SourceSHA, GOOS: "linux", GOARCH: "amd64", DynamicLibrary: "libwasmer_sdk_uniffi.so"})
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	archive := tar.NewWriter(gz)
	for name, data := range map[string][]byte{"LICENSE": []byte("license"), "native.json": native, "static/libwasmer_sdk_uniffi.a": []byte("static"), "dynamic/libwasmer_sdk_uniffi.so": []byte("dynamic")} {
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		archive.Write(data)
	}
	if extra != nil {
		if err := archive.WriteHeader(extra); err != nil {
			t.Fatal(err)
		}
	}
	archive.Close()
	gz.Close()
	hash := sha256.Sum256(buf.Bytes())
	manifest.Platforms = map[string]distribution.Artifact{"linux-amd64": {SHA256: hex.EncodeToString(hash[:]), Size: int64(buf.Len()), URL: "https://example.invalid/archive"}}
	name := filepath.Join(t.TempDir(), "native.tar.gz")
	if err := os.WriteFile(name, buf.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	return manifest, name
}

func TestInstallOfflineReuseAndCorruption(t *testing.T) {
	manifest, archive := archiveFixture(t, nil)
	cache := t.TempDir()
	directory, err := Install(context.Background(), manifest, "linux-amd64", cache, archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(directory, manifest, "linux-amd64"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), manifest, "linux-amd64", cache, ""); err != nil {
		t.Fatalf("offline reuse: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "static/libwasmer_sdk_uniffi.a"), []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(directory, manifest, "linux-amd64"); err == nil {
		t.Fatal("tampering accepted")
	}
	if _, err := Install(context.Background(), manifest, "linux-amd64", cache, ""); err == nil {
		t.Fatal("modified cache reused")
	}
}

func TestArchiveValidation(t *testing.T) {
	for _, header := range []*tar.Header{
		{Name: "../escape", Mode: 0644},
		{Name: "dynamic/link", Typeflag: tar.TypeSymlink, Linkname: "/tmp/escape"},
		{Name: "native.json", Mode: 0644},
	} {
		t.Run(header.Name, func(t *testing.T) {
			manifest, archive := archiveFixture(t, header)
			if _, err := Install(context.Background(), manifest, "linux-amd64", t.TempDir(), archive); err == nil {
				t.Fatal("invalid archive accepted")
			}
		})
	}
	manifest, archive := archiveFixture(t, nil)
	artifact := manifest.Platforms["linux-amd64"]
	artifact.SHA256 = strings.Repeat("0", 64)
	manifest.Platforms["linux-amd64"] = artifact
	if _, err := Install(context.Background(), manifest, "linux-amd64", t.TempDir(), archive); err == nil {
		t.Fatal("bad checksum accepted")
	}
	manifest, archive = archiveFixture(t, nil)
	manifest.SourceSHA = strings.Repeat("b", 40)
	if _, err := Install(context.Background(), manifest, "linux-amd64", t.TempDir(), archive); err == nil {
		t.Fatal("different native build accepted")
	}
}

func TestDownloadAndConcurrentInstall(t *testing.T) {
	manifest, archive := archiveFixture(t, nil)
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) }))
	defer server.Close()
	artifact := manifest.Platforms["linux-amd64"]
	artifact.URL = server.URL
	manifest.Platforms["linux-amd64"] = artifact
	cache := t.TempDir()
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if _, err := Install(context.Background(), manifest, "linux-amd64", cache, ""); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
}
