const vscode = require("vscode");

function activate(context) {
  const channel = new MessageChannel();
  const rpc = new RpcClient(channel.port2);
  const provider = new WasmerFileSystemProvider(rpc);
  context.subscriptions.push(
    rpc,
    provider,
    vscode.workspace.registerFileSystemProvider("wasmer", provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );
  context.messagePassingProtocol.postMessage(
    { type: "wasmer:connect", port: channel.port1 },
    [channel.port1],
  );
}

class RpcClient {
  constructor(port) {
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    port.addEventListener("message", (event) => {
      if (event.data?.type === "wasmer:save") {
        void vscode.commands.executeCommand("workbench.action.files.save");
        return;
      }
      const request = this.pending.get(event.data?.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.error) request.reject(toFileSystemError(event.data.error));
      else request.resolve(event.data.result);
    });
    port.start();
  }

  call(method, ...args) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.port.postMessage({ id, method, args });
    return result;
  }

  dispose() {
    this.port.close();
    for (const request of this.pending.values()) {
      request.reject(vscode.FileSystemError.Unavailable("Wasmer sandbox closed"));
    }
    this.pending.clear();
  }
}

class WasmerFileSystemProvider {
  constructor(rpc) {
    this.rpc = rpc;
    this.changes = new vscode.EventEmitter();
    this.onDidChangeFile = this.changes.event;
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  async stat(uri) {
    const value = await this.rpc.call("stat", uri.path);
    return {
      type: value.kind === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: value.ctime,
      mtime: value.mtime,
      size: value.size,
    };
  }

  async readDirectory(uri) {
    const entries = await this.rpc.call("readDirectory", uri.path);
    return entries.map((entry) => [
      entry.name,
      entry.kind === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  readFile(uri) {
    return this.rpc.call("readFile", uri.path);
  }

  async writeFile(uri, content) {
    await this.rpc.call("writeFile", uri.path, content);
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri) {
    await this.rpc.call("createDirectory", uri.path);
    this.changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri, options) {
    await this.rpc.call("delete", uri.path, options.recursive);
    this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri, newUri, options) {
    await this.rpc.call("rename", oldUri.path, newUri.path, options.overwrite);
    this.changes.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  dispose() {
    this.changes.dispose();
  }
}

function toFileSystemError(error) {
  const message = error?.message || "Wasmer filesystem operation failed";
  if (error?.code === "NOT_FOUND") return vscode.FileSystemError.FileNotFound(message);
  if (error?.code === "ALREADY_EXISTS") return vscode.FileSystemError.FileExists(message);
  if (error?.code === "NOT_A_DIRECTORY") return vscode.FileSystemError.FileNotADirectory(message);
  if (error?.code === "IS_A_DIRECTORY") return vscode.FileSystemError.FileIsADirectory(message);
  if (error?.code === "NO_PERMISSIONS") return vscode.FileSystemError.NoPermissions(message);
  return vscode.FileSystemError.Unavailable(message);
}

module.exports = { activate };
