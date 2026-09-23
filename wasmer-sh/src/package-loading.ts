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
  // Older releases can report completion, but don't expose byte counts.
  const packages: Package[] = [];
  const progress: PackageLoadProgress = {
    phase: "resolving", download: { downloadedBytes: 0, totalBytes: null, percent: null },
    packages: sources.map((source, index) => ({
      id: typeof source === "string" ? source : `Local package ${index + 1}`,
      phase: "resolving", cached: false,
      download: { downloadedBytes: 0, totalBytes: null, percent: null },
    })),
  };
  let failed = false;
  try {
    options.onProgress(progress);
    await Promise.all(sources.map(async (source, index) => {
      const pkg = await client.packages.load(source);
      packages[index] = pkg;
      if (failed || options.signal.aborted) return;
      progress.packages = progress.packages.map((entry, i) => i === index ? { ...entry, id: pkg.id, phase: "ready" } : entry);
      if (progress.packages.every(entry => entry.phase === "ready")) progress.phase = "ready";
      options.onProgress({ ...progress });
    }));
    options.signal.throwIfAborted();
    return packages;
  } catch (error) {
    failed = true;
    throw error;
  }
}
