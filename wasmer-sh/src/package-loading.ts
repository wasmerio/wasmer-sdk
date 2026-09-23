import type { Package, Wasmer } from "@wasmer/sdk";

// Keep standalone shell builds compatible with the currently published SDK.
// Once the minimum SDK version includes progress, import this type from it
// and call loadMany directly. The release workflow updates that dependency.
interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}
export interface PackageLoadProgress {
  phase: "resolving" | "downloading" | "loading" | "ready";
  download: DownloadProgress;
  packages: readonly {
    id: string;
    phase: PackageLoadProgress["phase"];
    cached: boolean;
    download: DownloadProgress;
  }[];
}
interface LoadOptions {
  signal: AbortSignal;
  onProgress: (progress: PackageLoadProgress) => void;
}
type ProgressivePackages = {
  loadMany(sources: readonly (string | Uint8Array)[], options: LoadOptions): Promise<Package[]>;
};

export async function loadExamplePackages(
  client: Wasmer,
  sources: readonly (string | Uint8Array)[],
  options: LoadOptions,
): Promise<Package[]> {
  options.signal.throwIfAborted();
  if ("loadMany" in client.packages && typeof client.packages.loadMany === "function") {
    return (client.packages as unknown as ProgressivePackages).loadMany(sources, options);
  }
  // An older SDK keeps its existing indeterminate loading screen. All package
  // resolution and caching still use the SDK, without a second download path.
  const packages = await Promise.all(sources.map(source => client.packages.load(source)));
  options.signal.throwIfAborted();
  return packages;
}
