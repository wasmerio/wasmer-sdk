package wasmer

import (
	"context"
	ffi "go.wasmer.io/sdk/internal/ffi"
)

type PackageLoadPhase string

const (
	PackageResolving   PackageLoadPhase = "resolving"
	PackageDownloading PackageLoadPhase = "downloading"
	PackageLoading     PackageLoadPhase = "loading"
	PackageReady       PackageLoadPhase = "ready"
)

// DownloadProgress counts decoded package bytes, excluding cache hits.
// Nil TotalBytes and Percent mean that the download size is not yet known.
type DownloadProgress struct {
	DownloadedBytes uint64
	TotalBytes      *uint64
	Percent         *float64
}
type PackageProgress struct {
	ID       string
	Phase    PackageLoadPhase
	Cached   bool
	Download DownloadProgress
}

// PackageLoadProgress is a snapshot, not a delta. 100% download completion
// does not imply that validation and package loading have completed.
type PackageLoadProgress struct {
	Phase    PackageLoadPhase
	Download DownloadProgress
	Packages []PackageProgress
}
type PackageLoadOptions struct {
	// OnProgress is serialized per load. Return promptly; do not panic or close
	// the owning client from inside its callback.
	OnProgress func(PackageLoadProgress)
}

func loadPhase(phase ffi.PackageLoadPhase) PackageLoadPhase {
	switch phase {
	case ffi.PackageLoadPhaseResolving:
		return PackageResolving
	case ffi.PackageLoadPhaseDownloading:
		return PackageDownloading
	case ffi.PackageLoadPhaseLoading:
		return PackageLoading
	case ffi.PackageLoadPhaseReady:
		return PackageReady
	default:
		return PackageResolving
	}
}
func downloadProgress(p ffi.DownloadProgress) DownloadProgress {
	return DownloadProgress{p.DownloadedBytes, p.TotalBytes, p.Percent}
}

type progressObserver struct{ callback func(PackageLoadProgress) }

func (o *progressObserver) OnProgress(p ffi.PackageLoadProgress) {
	value := PackageLoadProgress{Phase: loadPhase(p.Phase), Download: downloadProgress(p.Download), Packages: make([]PackageProgress, len(p.Packages))}
	for i, entry := range p.Packages {
		value.Packages[i] = PackageProgress{entry.Id, loadPhase(entry.Phase), entry.Cached, downloadProgress(entry.Download)}
	}
	o.callback(value)
}

func (p *Packages) loadSources(ctx context.Context, sources []ffi.PackageLoadSource, options PackageLoadOptions) ([]*Package, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	done, err := p.client.life.enter()
	if err != nil {
		return nil, err
	}
	defer done()
	cancellation := ffi.NewPackageLoadCancellation()
	stopped, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		select {
		case <-ctx.Done():
			cancellation.Cancel()
		case <-finished:
		}
	}()
	defer func() { close(finished); <-stopped; cancellation.Destroy() }()
	var observer *ffi.PackageLoadObserver
	if options.OnProgress != nil {
		var callback ffi.PackageLoadObserver = &progressObserver{options.OnProgress}
		observer = &callback
	}
	cores, err := p.client.core.LoadPackages(sources, observer, &cancellation)
	if cancelled := ctx.Err(); cancelled != nil {
		for _, core := range cores {
			core.Destroy()
		}
		return nil, cancelled
	}
	if err != nil {
		return nil, nativeError(err)
	}
	packages := make([]*Package, len(cores))
	for i, core := range cores {
		packages[i] = wrapPackage(p.client, core)
	}
	return packages, nil
}

func (p *Packages) LoadWithOptions(ctx context.Context, specifier string, options PackageLoadOptions) (*Package, error) {
	packages, err := p.loadSources(ctx, []ffi.PackageLoadSource{ffi.PackageLoadSourceRegistry{Specifier: specifier}}, options)
	if err != nil {
		return nil, err
	}
	return packages[0], nil
}
func (p *Packages) LoadPathWithOptions(ctx context.Context, path string, options PackageLoadOptions) (*Package, error) {
	packages, err := p.loadSources(ctx, []ffi.PackageLoadSource{ffi.PackageLoadSourcePath{Path: path}}, options)
	if err != nil {
		return nil, err
	}
	return packages[0], nil
}
func (p *Packages) LoadBytesWithOptions(ctx context.Context, bytes []byte, options PackageLoadOptions) (*Package, error) {
	packages, err := p.loadSources(ctx, []ffi.PackageLoadSource{ffi.PackageLoadSourceBytes{Bytes: bytes}}, options)
	if err != nil {
		return nil, err
	}
	return packages[0], nil
}

// LoadMany shares downloads and preserves input order.
func (p *Packages) LoadMany(ctx context.Context, specifiers []string, options PackageLoadOptions) ([]*Package, error) {
	sources := make([]ffi.PackageLoadSource, len(specifiers))
	for i, specifier := range specifiers {
		sources[i] = ffi.PackageLoadSourceRegistry{Specifier: specifier}
	}
	return p.loadSources(ctx, sources, options)
}
