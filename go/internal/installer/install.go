// Package installer downloads and verifies native libraries outside GOMODCACHE.
package installer

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.wasmer.io/sdk/internal/distribution"
)

var versionPattern = regexp.MustCompile(`^(0|1)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var platforms = map[string]string{"darwin-arm64": "dylib", "darwin-amd64": "dylib", "linux-arm64": "so", "linux-amd64": "so"}

type Native struct {
	Schema          int    `json:"schema"`
	Version         string `json:"version"`
	SourceSHA       string `json:"source_sha"`
	GOOS            string `json:"goos"`
	GOARCH          string `json:"goarch"`
	StaticLinkFlags string `json:"static_link_flags"`
	DynamicLibrary  string `json:"dynamic_library"`
}
type receipt struct {
	SHA256 string            `json:"sha256"`
	Files  map[string]string `json:"files"`
}

func Directory(cache string, manifest distribution.Manifest, target string) (string, error) {
	a, ok := manifest.Platforms[target]
	if !ok || platforms[target] == "" {
		return "", fmt.Errorf("unsupported target %s", target)
	}
	if !versionPattern.MatchString(manifest.Version) || !hashPattern.MatchString(a.SHA256) || a.Size <= 0 || a.Size > 2<<30 {
		return "", errors.New("invalid native release manifest")
	}
	return filepath.Join(cache, manifest.Version, target, a.SHA256), nil
}

func fileHash(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func validateNative(directory string, manifest distribution.Manifest, target string) (Native, error) {
	var native Native
	b, err := os.ReadFile(filepath.Join(directory, "native.json"))
	if err != nil {
		return native, err
	}
	if err := json.Unmarshal(b, &native); err != nil {
		return native, err
	}
	if native.Schema != 1 || native.Version != manifest.Version || native.SourceSHA != manifest.SourceSHA ||
		native.GOOS+"-"+native.GOARCH != target || native.DynamicLibrary != "libwasmer_sdk_uniffi."+platforms[target] {
		return native, errors.New("native library identity differs from selected Go module")
	}
	for _, name := range []string{"static/libwasmer_sdk_uniffi.a", "dynamic/" + native.DynamicLibrary, "LICENSE"} {
		info, err := os.Lstat(filepath.Join(directory, filepath.FromSlash(name)))
		if err != nil {
			return native, err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return native, fmt.Errorf("missing native file %s", name)
		}
	}
	return native, nil
}

// Verify checks installed bytes as well as the archive receipt. This also detects
// an incomplete or edited cache before invoking a compiler.
func Verify(directory string, manifest distribution.Manifest, target string) (Native, error) {
	var r receipt
	b, err := os.ReadFile(filepath.Join(directory, "receipt.json"))
	if err != nil {
		return Native{}, err
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return Native{}, err
	}
	if r.SHA256 != manifest.Platforms[target].SHA256 || len(r.Files) < 4 {
		return Native{}, errors.New("invalid installation receipt")
	}
	for name, expected := range r.Files {
		if !filepath.IsLocal(name) || strings.Contains(name, "\\") {
			return Native{}, errors.New("invalid receipt path")
		}
		info, err := os.Lstat(filepath.Join(directory, name))
		if err != nil {
			return Native{}, err
		}
		if !info.Mode().IsRegular() {
			return Native{}, fmt.Errorf("invalid cached file %s", name)
		}
		got, err := fileHash(filepath.Join(directory, name))
		if err != nil {
			return Native{}, err
		}
		if got != expected {
			return Native{}, fmt.Errorf("cached file checksum mismatch: %s", name)
		}
	}
	return validateNative(directory, manifest, target)
}

func Install(ctx context.Context, manifest distribution.Manifest, target, cache, archivePath string) (string, error) {
	directory, err := Directory(cache, manifest, target)
	if err != nil {
		return "", err
	}
	if _, err := Verify(directory, manifest, target); err == nil {
		return directory, nil
	}
	// Never overwrite a corrupt cache implicitly. It may be in use by another build.
	if _, err := os.Stat(directory); err == nil {
		return "", fmt.Errorf("native cache is incomplete or modified; remove %s and reinstall", directory)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(directory)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	a := manifest.Platforms[target]
	var source io.ReadCloser
	if archivePath != "" {
		source, err = os.Open(archivePath)
	} else {
		var req *http.Request
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
		if err == nil {
			var response *http.Response
			response, err = (&http.Client{Timeout: 10 * time.Minute}).Do(req)
			if err == nil {
				if response.StatusCode != http.StatusOK {
					response.Body.Close()
					return "", fmt.Errorf("download returned HTTP %d", response.StatusCode)
				}
				source = response.Body
			}
		}
	}
	if err != nil {
		return "", err
	}
	defer source.Close()
	archive, err := os.CreateTemp(parent, ".download-")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(source, a.Size+1))
	if err != nil {
		return "", err
	}
	if written != a.Size || hex.EncodeToString(hash.Sum(nil)) != a.SHA256 {
		return "", errors.New("native archive size or SHA-256 mismatch")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	gz, err := gzip.NewReader(archive)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	tarReader := tar.NewReader(gz)
	files := make(map[string]string)
	var expanded int64
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || !filepath.IsLocal(name) || path.Clean(name) != name || strings.Contains(name, "\\") || name == "receipt.json" {
			return "", fmt.Errorf("invalid archive path %q", header.Name)
		}
		destination := filepath.Join(staging, filepath.FromSlash(name))
		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(destination, 0755); err != nil {
				return "", err
			}
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size < 0 {
			return "", errors.New("native archive must contain only regular files and directories")
		}
		expanded += header.Size
		if expanded > 4<<30 {
			return "", errors.New("native archive expands beyond 4 GiB")
		}
		if _, exists := files[name]; exists {
			return "", fmt.Errorf("duplicate archive member %s", name)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			return "", err
		}
		file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return "", err
		}
		h := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(file, h), tarReader)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		files[name] = hex.EncodeToString(h.Sum(nil))
	}
	if _, err := validateNative(staging, manifest, target); err != nil {
		return "", err
	}
	b, err := json.Marshal(receipt{a.SHA256, files})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(staging, "receipt.json"), b, 0644); err != nil {
		return "", err
	}
	if err := os.Rename(staging, directory); err != nil {
		if _, verifyErr := Verify(directory, manifest, target); verifyErr != nil {
			return "", err
		}
	}
	return directory, nil
}
