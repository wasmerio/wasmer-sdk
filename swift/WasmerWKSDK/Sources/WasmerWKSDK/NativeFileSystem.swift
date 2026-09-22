import Darwin
import CoreFoundation
import Foundation

struct NativeIOError: Error {
  let number: Int32
  init(_ number: Int32 = errno) { self.number = number }
  var code: String {
    switch number {
    case ENOENT: "ENOENT"
    case EEXIST: "EEXIST"
    case EACCES: "EACCES"
    case EPERM: "EPERM"
    case ELOOP: "ELOOP"
    case ENOTDIR: "ENOTDIR"
    case EISDIR: "EISDIR"
    case ENOTEMPTY: "ENOTEMPTY"
    case ENOTSUP: "ENOTSUP"
    case EINVAL: "EINVAL"
    default: "EIO"
    }
  }
}

/// Foundation objects stay at the WebKit boundary. Only these value types
/// cross to the filesystem actor, without encoding and decoding JSON.
enum NativeFileSystemRequest: Sendable {
  struct OpenOptions: Sendable {
    let read, write, create, exclusive, truncate, append: Bool
    var writes: Bool { write || create || exclusive || truncate || append }
  }
  enum WriteData: Sendable {
    case bytes(Data)
    case base64(String)
  }

  case stat(String)
  case open(String, OpenOptions)
  case read(Int, offset: Int, count: Int, base64: Bool)
  case write(Int, offset: Int, WriteData)
  case setLen(Int, Int)
  case flush(Int)
  case sync
  case close(Int)
  case mkdir(String)
  case remove(String)
  case rename(String, String)
  case readDir(String)

  init(_ body: [String: Any]) throws {
    guard let method = body["method"] as? String else { throw NativeIOError(EINVAL) }
    let args = body["args"] as? [Any] ?? []
    func string(_ index: Int) throws -> String {
      guard args.indices.contains(index), let value = args[index] as? String,
        !value.utf8.contains(0) else { throw NativeIOError(EINVAL) }
      return value
    }
    func integer(_ index: Int) throws -> Int {
      guard args.indices.contains(index), let value = args[index] as? NSNumber,
        CFGetTypeID(value) != CFBooleanGetTypeID(),
        value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
        value.doubleValue.rounded(.towardZero) == value.doubleValue
      else { throw NativeIOError(EINVAL) }
      return value.intValue
    }
    switch method {
    case "stat": self = .stat(try string(0))
    case "open":
      guard args.count == 7 else { throw NativeIOError(EINVAL) }
      let options = args.dropFirst().map { ($0 as? Bool) ?? false }
      self = .open(try string(0), OpenOptions(
        read: options[0], write: options[1], create: options[2],
        exclusive: options[3], truncate: options[4], append: options[5]))
    case "read", "readBytes":
      let count = try integer(2)
      guard count <= 65536 else { throw NativeIOError(EINVAL) }
      self = .read(try integer(0), offset: try integer(1), count: count, base64: method == "readBytes")
    case "write", "writeBytes":
      guard args.count == 3 else { throw NativeIOError(EINVAL) }
      let data: WriteData
      if method == "writeBytes" {
        guard let encoded = args[2] as? String, encoded.utf8.count <= 87384
        else { throw NativeIOError(EINVAL) }
        // Decode on the filesystem actor, away from the UI thread.
        data = .base64(encoded)
      } else {
        guard let numbers = args[2] as? [Int], numbers.count <= 65536,
          numbers.allSatisfy({ (0...255).contains($0) }) else { throw NativeIOError(EINVAL) }
        data = .bytes(Data(numbers.map(UInt8.init)))
      }
      self = .write(try integer(0), offset: try integer(1), data)
    case "setLen": self = .setLen(try integer(0), try integer(1))
    case "flush": self = .flush(try integer(0))
    case "sync": self = .sync
    case "close": self = .close(try integer(0))
    case "mkdir": self = .mkdir(try string(0))
    case "remove": self = .remove(try string(0))
    case "rename": self = .rename(try string(0), try string(1))
    case "readDir": self = .readDir(try string(0))
    default: throw NativeIOError(ENOTSUP)
    }
  }

  var writes: Bool {
    switch self {
    case .open(_, let options): options.writes
    case .write, .setLen, .mkdir, .remove, .rename: true
    default: false
    }
  }
}

struct NativeFileMetadata: Sendable {
  let isDirectory: Bool
  let size: Int64
  var object: [String: Any] { ["kind": isDirectory ? "directory" : "file", "size": size] }
}

struct NativeDirectoryEntry: Sendable {
  let name: String
  let metadata: NativeFileMetadata
  var object: [String: Any] {
    var result = metadata.object
    result["name"] = name
    return result
  }
}

enum NativeFileSystemValue: Sendable {
  case null
  case integer(Int)
  case string(String)
  case bytes(Data)
  case metadata(NativeFileMetadata)
  case entries([NativeDirectoryEntry])

  var object: Any {
    switch self {
    case .null: NSNull()
    case .integer(let value): value
    case .string(let value): value
    case .bytes(let value): value.map(Int.init)
    case .metadata(let value): value.object
    case .entries(let value): value.map(\.object)
    }
  }
}

enum NativeFileSystemResponse: Sendable {
  case value(NativeFileSystemValue)
  case error(NativeIOError)

  var object: [String: Any] {
    switch self {
    case .value(let value): ["value": value.object]
    case .error(let error):
      ["error": ["code": error.code, "message": String(cString: strerror(error.number))]]
    }
  }
}

/// Owns descriptors on a separate actor. Paths are resolved relative to an
/// opened root, with O_NOFOLLOW on every component; symlink escapes are rejected.
actor NativeFileSystem {
  private var root: Int32
  private var files: [Int: Int32] = [:]
  private var nextID = 0
  private(set) var operations = 0
  private var closed = false

  init(directory: URL) throws {
    root = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard root >= 0 else { throw NativeIOError() }
  }

  deinit {
    for fd in files.values { Darwin.close(fd) }
    if root >= 0 { Darwin.close(root) }
  }

  func shutdown() {
    guard !closed else { return }
    closed = true
    for fd in files.values { Darwin.close(fd) }
    files.removeAll()
    Darwin.close(root)
    root = -1
  }

  func dispatch(_ request: NativeFileSystemRequest, readOnly: Bool) -> NativeFileSystemResponse {
    do {
      guard !closed else { throw NativeIOError(EBADF) }
      operations += 1
      if readOnly && request.writes { throw NativeIOError(EACCES) }
      return .value(try execute(request))
    } catch {
      return .error(error as? NativeIOError ?? NativeIOError(EIO))
    }
  }

  private func file(_ id: Int) throws -> Int32 {
    guard let fd = files[id] else { throw NativeIOError(EBADF) }
    return fd
  }

  private func checked(_ value: Int32) throws -> Int32 {
    guard value >= 0 else { throw NativeIOError() }
    return value
  }

  private func parent(_ path: String) throws -> (Int32, String) {
    guard !path.hasPrefix("/"), !path.utf8.contains(0) else { throw NativeIOError(EACCES) }
    let parts = path.split(separator: "/").map(String.init).filter { $0 != "." }
    guard !parts.contains("..") else { throw NativeIOError(EACCES) }
    var fd = try checked(dup(root))
    do {
      for part in parts.dropLast() {
        let next = try checked(openat(fd, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW))
        Darwin.close(fd)
        fd = next
      }
      return (fd, parts.last ?? ".")
    } catch {
      Darwin.close(fd)
      throw error
    }
  }

  private func withParent<T>(_ path: String, _ operation: (Int32, String) throws -> T) throws -> T {
    let (fd, name) = try parent(path)
    defer { Darwin.close(fd) }
    return try operation(fd, name)
  }

  private func metadata(_ directory: Int32, _ name: String) throws -> NativeFileMetadata {
    var info = stat()
    _ = try checked(fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW))
    let type = info.st_mode & S_IFMT
    guard type == S_IFREG || type == S_IFDIR else { throw NativeIOError(EACCES) }
    return NativeFileMetadata(isDirectory: type == S_IFDIR, size: info.st_size)
  }

  private func execute(_ request: NativeFileSystemRequest) throws -> NativeFileSystemValue {
    switch request {
    case .stat(let path):
      return .metadata(try withParent(path) { try metadata($0, $1) })
    case .open(let path, let options):
      var flags = (options.read && (options.write || options.append)) ? O_RDWR :
        ((options.write || options.append) ? O_WRONLY : O_RDONLY)
      flags |= O_CLOEXEC | O_NOFOLLOW
      if options.create || options.exclusive { flags |= O_CREAT }
      if options.exclusive { flags |= O_EXCL }
      if options.truncate { flags |= O_TRUNC }
      // Offset-based writes are serialized by this actor. O_APPEND preserves
      // append semantics when separate guest descriptors write the same file.
      if options.append { flags |= O_APPEND }
      let fd = try withParent(path) { try checked(openat($0, $1, flags, 0o600)) }
      var info = stat()
      guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
        Darwin.close(fd)
        throw NativeIOError(EISDIR)
      }
      nextID += 1
      files[nextID] = fd
      return .integer(nextID)
    case .read(let id, let offset, let count, let base64):
      let fd = try file(id)
      var bytes = Data(count: count)
      let length = bytes.withUnsafeMutableBytes { pread(fd, $0.baseAddress, count, off_t(offset)) }
      guard length >= 0 else { throw NativeIOError() }
      bytes.count = length
      return base64 ? .string(bytes.base64EncodedString()) : .bytes(bytes)
    case .write(let id, let offset, let data):
      let fd = try file(id)
      let bytes: Data
      switch data {
      case .base64(let encoded):
        guard let decoded = Data(base64Encoded: encoded), decoded.count <= 65536
        else { throw NativeIOError(EINVAL) }
        bytes = decoded
      case .bytes(let value): bytes = value
      }
      let count = bytes.withUnsafeBytes { pwrite(fd, $0.baseAddress, $0.count, off_t(offset)) }
      guard count >= 0 else { throw NativeIOError() }
      return .integer(count)
    case .setLen(let id, let length):
      _ = try checked(ftruncate(file(id), off_t(length)))
    case .flush(let id):
      _ = try checked(fsync(file(id)))
    case .sync:
      for fd in files.values { _ = try checked(fsync(fd)) }
    case .close(let id):
      if let fd = files.removeValue(forKey: id) { Darwin.close(fd) }
    case .mkdir(let path):
      _ = try withParent(path) { try checked(mkdirat($0, $1, 0o700)) }
    case .remove(let path):
      _ = try withParent(path) { fd, name in
        guard name != "." else { throw NativeIOError(EACCES) }
        let info = try metadata(fd, name)
        return try checked(unlinkat(fd, name, info.isDirectory ? AT_REMOVEDIR : 0))
      }
    case .rename(let source, let destination):
      _ = try withParent(source) { fromFD, from in
        try withParent(destination) { toFD, to in
          guard from != ".", to != "." else { throw NativeIOError(EACCES) }
          _ = try metadata(fromFD, from)
          return try checked(renameat(fromFD, from, toFD, to))
        }
      }
    case .readDir(let path):
      let fd = try withParent(path) { try checked(openat($0, $1, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)) }
      guard let directory = fdopendir(fd) else { Darwin.close(fd); throw NativeIOError() }
      defer { closedir(directory) }
      var entries: [NativeDirectoryEntry] = []
      while let entry = readdir(directory) {
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
          $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if name == "." || name == ".." { continue }
        entries.append(NativeDirectoryEntry(name: name, metadata: try metadata(fd, name)))
      }
      return .entries(entries)
    }
    return .null
  }
}
