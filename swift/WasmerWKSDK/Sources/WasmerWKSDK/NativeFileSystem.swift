import Darwin
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

  func dispatch(_ request: Data) -> Data {
    let result: [String: Any]
    do {
      guard !closed else { throw NativeIOError(EBADF) }
      guard let body = try JSONSerialization.jsonObject(with: request) as? [String: Any],
        let mount = body["mount"] as? Int, [1, 2].contains(mount),
        let method = body["method"] as? String
      else { throw NativeIOError(EINVAL) }
      let args = body["args"] as? [Any] ?? []
      operations += 1
      result = ["value": try execute(method, args, readOnly: mount == 2)]
    } catch {
      let io = error as? NativeIOError ?? NativeIOError(EIO)
      result = ["error": ["code": io.code, "message": String(cString: strerror(io.number))]]
    }
    return try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  }

  private func string(_ args: [Any], _ index: Int) throws -> String {
    guard args.indices.contains(index), let value = args[index] as? String,
      !value.utf8.contains(0) else { throw NativeIOError(EINVAL) }
    return value
  }

  private func integer(_ args: [Any], _ index: Int) throws -> Int {
    guard args.indices.contains(index), let value = args[index] as? NSNumber,
      value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
      value.doubleValue.rounded(.towardZero) == value.doubleValue
    else { throw NativeIOError(EINVAL) }
    return value.intValue
  }

  private func file(_ args: [Any]) throws -> Int32 {
    guard let fd = files[try integer(args, 0)] else { throw NativeIOError(EBADF) }
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

  private func metadata(_ directory: Int32, _ name: String) throws -> [String: Any] {
    var info = stat()
    _ = try checked(fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW))
    let type = info.st_mode & S_IFMT
    guard type == S_IFREG || type == S_IFDIR else { throw NativeIOError(EACCES) }
    return ["kind": type == S_IFDIR ? "directory" : "file", "size": info.st_size]
  }

  private func execute(_ method: String, _ args: [Any], readOnly: Bool) throws -> Any {
    if readOnly && ["write", "setLen", "mkdir", "remove", "rename"].contains(method) {
      throw NativeIOError(EACCES)
    }
    switch method {
    case "stat":
      return try withParent(string(args, 0)) { try metadata($0, $1) }
    case "open":
      guard args.count == 7 else { throw NativeIOError(EINVAL) }
      let options = args.dropFirst().map { ($0 as? Bool) ?? false }
      let (read, write, create, exclusive, truncate, append) =
        (options[0], options[1], options[2], options[3], options[4], options[5])
      if readOnly && (write || create || exclusive || truncate || append) { throw NativeIOError(EACCES) }
      var flags = (read && (write || append)) ? O_RDWR : ((write || append) ? O_WRONLY : O_RDONLY)
      flags |= O_CLOEXEC | O_NOFOLLOW
      if create || exclusive { flags |= O_CREAT }
      if exclusive { flags |= O_EXCL }
      if truncate { flags |= O_TRUNC }
      // Offset-based writes are serialized by this actor. O_APPEND preserves
      // append semantics when separate guest descriptors write the same file.
      if append { flags |= O_APPEND }
      let fd = try withParent(string(args, 0)) { try checked(openat($0, $1, flags, 0o600)) }
      var info = stat()
      guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
        Darwin.close(fd)
        throw NativeIOError(EISDIR)
      }
      nextID += 1
      files[nextID] = fd
      return nextID
    case "read":
      let fd = try file(args)
      let offset = try integer(args, 1)
      let count = try integer(args, 2)
      guard count <= 65536 else { throw NativeIOError(EINVAL) }
      var bytes = [UInt8](repeating: 0, count: count)
      let length = bytes.withUnsafeMutableBytes { pread(fd, $0.baseAddress, count, off_t(offset)) }
      guard length >= 0 else { throw NativeIOError() }
      return Array(bytes.prefix(length))
    case "write":
      let fd = try file(args)
      let offset = try integer(args, 1)
      guard args.count == 3, let numbers = args[2] as? [Int], numbers.count <= 65536,
        numbers.allSatisfy({ (0...255).contains($0) }) else { throw NativeIOError(EINVAL) }
      let bytes = numbers.map(UInt8.init)
      let count = bytes.withUnsafeBytes { pwrite(fd, $0.baseAddress, $0.count, off_t(offset)) }
      guard count >= 0 else { throw NativeIOError() }
      return count
    case "setLen":
      _ = try checked(ftruncate(file(args), off_t(integer(args, 1))))
    case "flush":
      _ = try checked(fsync(file(args)))
    case "sync":
      for fd in files.values { _ = try checked(fsync(fd)) }
    case "close":
      if let fd = files.removeValue(forKey: try integer(args, 0)) { Darwin.close(fd) }
    case "mkdir":
      _ = try withParent(string(args, 0)) { try checked(mkdirat($0, $1, 0o700)) }
    case "remove":
      _ = try withParent(string(args, 0)) { fd, name in
        guard name != "." else { throw NativeIOError(EACCES) }
        let info = try metadata(fd, name)
        return try checked(unlinkat(fd, name, info["kind"] as? String == "directory" ? AT_REMOVEDIR : 0))
      }
    case "rename":
      _ = try withParent(string(args, 0)) { fromFD, from in
        try withParent(string(args, 1)) { toFD, to in
          guard from != ".", to != "." else { throw NativeIOError(EACCES) }
          _ = try metadata(fromFD, from)
          return try checked(renameat(fromFD, from, toFD, to))
        }
      }
    case "readDir":
      let fd = try withParent(string(args, 0)) { try checked(openat($0, $1, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)) }
      guard let directory = fdopendir(fd) else { Darwin.close(fd); throw NativeIOError() }
      defer { closedir(directory) }
      var entries: [[String: Any]] = []
      while let entry = readdir(directory) {
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
          $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if name == "." || name == ".." { continue }
        var info = try metadata(fd, name)
        info["name"] = name
        entries.append(info)
      }
      return entries
    default: throw NativeIOError(ENOTSUP)
    }
    return NSNull()
  }
}
