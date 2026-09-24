// Package distribution provides release metadata without importing the native SDK.
package distribution

import (
	"embed"
	"encoding/json"
	"fmt"
)

// native.json is added to the released module after the native archives are
// sealed. The development fallback lets maintainers test the helper in Git.
//
//go:embed *.json
var manifests embed.FS

type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Manifest struct {
	Schema    int                 `json:"schema"`
	Module    string              `json:"module"`
	Version   string              `json:"version"`
	SourceSHA string              `json:"source_sha"`
	Platforms map[string]Artifact `json:"platforms"`
}

func Load() (Manifest, error) {
	bytes, err := manifests.ReadFile("native.json")
	if err != nil {
		bytes, err = manifests.ReadFile("development.json")
	}
	var manifest Manifest
	if err == nil {
		err = json.Unmarshal(bytes, &manifest)
	}
	if err != nil {
		return manifest, err
	}
	if manifest.Schema != 1 || manifest.Module != "go.wasmer.io/sdk" {
		return manifest, fmt.Errorf("invalid native manifest")
	}
	return manifest, nil
}
