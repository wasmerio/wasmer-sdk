package wasmer_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	wasmer "go.wasmer.io/sdk"
)

func TestPackageLoadProgress(t *testing.T) {
	w := client(t)
	var mu sync.Mutex
	var updates []wasmer.PackageLoadProgress
	options := wasmer.PackageLoadOptions{OnProgress: func(p wasmer.PackageLoadProgress) {
		mu.Lock()
		updates = append(updates, p)
		mu.Unlock()
	}}
	pkg, err := w.Packages.LoadBytesWithOptions(context.Background(), fixture(t, "hello"), options)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := pkg.Entrypoint(); !ok {
		t.Fatal("missing entrypoint")
	}
	mu.Lock()
	last := updates[len(updates)-1]
	mu.Unlock()
	if last.Phase != wasmer.PackageReady || last.Download.DownloadedBytes != 0 || last.Download.TotalBytes == nil || *last.Download.TotalBytes != 0 || last.Download.Percent == nil || *last.Download.Percent != 100 {
		t.Fatalf("final snapshot: %+v", last)
	}
	packages, err := w.Packages.LoadMany(context.Background(), nil, options)
	if err != nil || len(packages) != 0 {
		t.Fatalf("empty batch: %v %v", packages, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = w.Packages.LoadWithOptions(ctx, "unused/package", options)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
