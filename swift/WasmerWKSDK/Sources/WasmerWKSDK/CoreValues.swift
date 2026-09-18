import Foundation

// The WebKit adapter implements the same core contract as the generated UniFFI
// module. The public WasmerSDK facade is shared across both implementations.
public enum SdkError: Error, LocalizedError, Sendable {
  case Failure(code: String, message: String)
  public var errorDescription: String? {
    switch self {
    case .Failure(_, let message): return message
    }
  }
}
public enum NetworkMode: String, Sendable, Codable { case disabled, host }
public enum InputMode: String, Sendable, Codable { case closed, pipe }
public enum OutputMode: String, Sendable, Codable { case pipe, capture, discard }
public enum ProcessExitReason: String, Sendable, Codable {
  case exited, terminated, timeout, unknown
}
public enum FileKind: String, Sendable, Codable { case file, directory }

public struct ClientOptions: Sendable, Codable, Equatable, Hashable {
  public let cacheRoot: String?
  public let outputBytes: UInt64?

  public init(cacheRoot: String?, outputBytes: UInt64?) {
    self.cacheRoot = cacheRoot
    self.outputBytes = outputBytes
  }

}

public struct DirectoryEntry: Sendable, Codable, Equatable, Hashable {
  public let name: String
  public let kind: FileKind
  public let size: UInt64

  public init(name: String, kind: FileKind, size: UInt64) {
    self.name = name
    self.kind = kind
    self.size = size
  }

}

public struct FileStat: Sendable, Codable, Equatable, Hashable {
  public let kind: FileKind
  public let size: UInt64

  public init(kind: FileKind, size: UInt64) {
    self.kind = kind
    self.size = size
  }

}

public struct PackageCommandDefinition: Sendable, Codable, Equatable, Hashable {
  public let module: String

  public init(module: String) {
    self.module = module
  }

}

public struct PackageDefinition: Sendable, Codable, Equatable, Hashable {
  public let modules: [String: Data]
  public let commands: [String: PackageCommandDefinition]
  public let entrypoint: String?
  public let files: [String: Data]

  public init(
    modules: [String: Data], commands: [String: PackageCommandDefinition], entrypoint: String?,
    files: [String: Data]
  ) {
    self.modules = modules
    self.commands = commands
    self.entrypoint = entrypoint
    self.files = files
  }

}

public struct ProcessOutput: Sendable, Codable, Equatable, Hashable {
  public let exitCode: Int32
  public let reason: ProcessExitReason
  public let stdout: Data
  public let stderr: Data
  public let stdoutTruncated: Bool
  public let stderrTruncated: Bool

  public init(
    exitCode: Int32, reason: ProcessExitReason, stdout: Data, stderr: Data, stdoutTruncated: Bool,
    stderrTruncated: Bool
  ) {
    self.exitCode = exitCode
    self.reason = reason
    self.stdout = stdout
    self.stderr = stderr
    self.stdoutTruncated = stdoutTruncated
    self.stderrTruncated = stderrTruncated
  }

}

public struct RunOptions: Sendable, Codable, Equatable, Hashable {
  public let input: Data?
  public let timeoutMs: UInt64?
  public let outputBytes: UInt64?

  public init(input: Data?, timeoutMs: UInt64?, outputBytes: UInt64?) {
    self.input = input
    self.timeoutMs = timeoutMs
    self.outputBytes = outputBytes
  }

}

public struct SpawnOptions: Sendable, Codable, Equatable, Hashable {
  public let timeoutMs: UInt64?
  public let outputBytes: UInt64?
  public let stdin: InputMode
  public let stdout: OutputMode
  public let stderr: OutputMode

  public init(
    timeoutMs: UInt64?, outputBytes: UInt64?, stdin: InputMode, stdout: OutputMode,
    stderr: OutputMode
  ) {
    self.timeoutMs = timeoutMs
    self.outputBytes = outputBytes
    self.stdin = stdin
    self.stdout = stdout
    self.stderr = stderr
  }

}
