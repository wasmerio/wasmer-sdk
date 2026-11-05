// Shared public data contracts; importing core types does not load an execution backend.
export type FileContents = string | Uint8Array;

/** A WASI/WASIX command referencing a named module in its package. */
export interface PackageCommandDefinition {
  module: string;
}

/** Executable content used to create a package without a WEBC archive. */
export interface PackageDefinition {
  modules: Readonly<Record<string, Uint8Array>>;
  commands: Readonly<Record<string, PackageCommandDefinition>>;
  /** Command name; inferred when there is exactly one command. */
  entrypoint?: string;
  /** Bundled files at canonical absolute guest paths, e.g. /data/config.json. */
  files?: Readonly<Record<string, FileContents>>;
}

export type PackageLoadPhase = "resolving" | "downloading" | "loading" | "ready";

/** Decoded package bytes; cache hits and local sources add zero download bytes. */
export interface DownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  /** Download completion from 0–100, or null while indeterminate. */
  readonly percent: number | null;
}

export interface PackageProgress {
  readonly id: string;
  readonly phase: PackageLoadPhase;
  readonly cached: boolean;
  readonly download: DownloadProgress;
}

/** A snapshot, not a delta. Download completion does not imply load readiness. */
export interface PackageLoadProgress {
  readonly phase: PackageLoadPhase;
  readonly download: DownloadProgress;
  readonly packages: readonly PackageProgress[];
}

export type ExitReason = "exited" | "terminated" | "timeout";

export interface FileStat {
  kind: "file" | "directory";
  size: number;
}

export interface DirectoryEntry extends FileStat {
  name: string;
}

