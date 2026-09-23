import Foundation

public enum PackageLoadPhase: String, Codable, Sendable, Equatable, Hashable { case resolving, downloading, loading, ready }
public struct DownloadProgress: Codable, Sendable, Equatable, Hashable {
  public let downloadedBytes: UInt64
  public let totalBytes: UInt64?
  public let percent: Double?
  public init(downloadedBytes: UInt64, totalBytes: UInt64?, percent: Double?) {
    self.downloadedBytes = downloadedBytes; self.totalBytes = totalBytes; self.percent = percent
  }
}
public struct PackageProgress: Codable, Sendable, Equatable, Hashable {
  public let id: String
  public let phase: PackageLoadPhase
  public let cached: Bool
  public let download: DownloadProgress
  public init(id: String, phase: PackageLoadPhase, cached: Bool, download: DownloadProgress) {
    self.id = id; self.phase = phase; self.cached = cached; self.download = download
  }
}
public struct PackageLoadProgress: Codable, Sendable, Equatable, Hashable {
  public let phase: PackageLoadPhase
  public let download: DownloadProgress
  public let packages: [PackageProgress]
  public init(phase: PackageLoadPhase, download: DownloadProgress, packages: [PackageProgress]) {
    self.phase = phase; self.download = download; self.packages = packages
  }
}
public protocol PackageLoadObserver: AnyObject, Sendable {
  func onProgress(progress: PackageLoadProgress)
}

/// Matches the native backend's cancellation token without exposing WebKit.
public final class PackageLoadCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var handler: (@Sendable () -> Void)?
  public init() {}
  public func cancel() {
    let handler = lock.withLock { cancelled = true; return self.handler }
    handler?()
  }
  func attach(_ handler: @escaping @Sendable () -> Void) {
    let cancelled = lock.withLock { self.handler = handler; return self.cancelled }
    if cancelled { handler() }
  }
  func detach() { lock.withLock { handler = nil } }
}

@available(macOS 14.0, iOS 27.0, *)
public enum PackageLoadSource: Sendable {
  case registry(specifier: String)
  case path(path: String)
  case bytes(bytes: Data)
  case package(package: PackageCore)
}
