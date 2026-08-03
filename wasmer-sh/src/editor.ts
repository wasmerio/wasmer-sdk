import type { Sandbox } from "@wasmer/sdk2/browser";

const WORKBENCH_ROOT = "/workbench-code/";
const EXTENSION_ID = "wasmer.workbench";

interface AmdRequire {
  (modules: string[], resolve: (module: WorkbenchModule) => void, reject: (error: unknown) => void): void;
  config(options: { baseUrl: string }): void;
}

interface WorkbenchModule {
  URI: { parse(value: string): unknown };
  create(container: HTMLElement, options: Record<string, unknown>): unknown;
}

type WorkbenchGlobal = typeof globalThis & {
  require?: AmdRequire;
};

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  args?: unknown;
}

export class WorkspaceEditor {
  readonly #container: HTMLElement;
  readonly #getSandbox: () => Sandbox | undefined;
  readonly #mtimes = new Map<string, number>();
  #initialization?: Promise<void>;
  #fileSystemPort?: MessagePort;

  constructor(container: HTMLElement, getSandbox: () => Sandbox | undefined) {
    this.#container = container;
    this.#getSandbox = getSandbox;
  }

  load(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  save(): void {
    this.#fileSystemPort?.postMessage({ type: "wasmer:save" });
  }

  async #initialize(): Promise<void> {
    loadWorkbenchStyles();
    await loadScript(`${WORKBENCH_ROOT}out/nls.messages.js`);
    await loadScript(`${WORKBENCH_ROOT}out/vs/loader.js`);
    const amd = (globalThis as WorkbenchGlobal).require;
    if (!amd) throw new Error("Code OSS failed to initialize its module loader");
    amd.config({
      baseUrl: new URL(`${WORKBENCH_ROOT}out`, window.location.origin).href,
    });
    const workbench = await new Promise<WorkbenchModule>((resolve, reject) => {
      amd(["vs/workbench/workbench.web.main"], resolve, reject);
    });

    const channel = new MessageChannel();
    channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: unknown; port?: unknown } | null;
      if (message?.type !== "wasmer:connect") return;
      const port = message.port instanceof MessagePort ? message.port : event.ports[0];
      if (port) this.#attachFileSystem(port);
    });
    channel.port2.start();

    const folderUri = workbench.URI.parse("wasmer:/workspace");
    const readmeUri = workbench.URI.parse("wasmer:/workspace/README.md");
    const extensionUri = workbench.URI.parse(
      new URL("/editor-extension/", window.location.origin).href,
    );
    workbench.create(this.#container, {
      additionalBuiltinExtensions: [extensionUri],
      configurationDefaults: {
        "breadcrumbs.enabled": false,
        "editor.minimap.enabled": false,
        "explorer.compactFolders": false,
        "files.autoSave": "off",
        "window.commandCenter": false,
        "window.menuBarVisibility": "hidden",
        "workbench.activityBar.location": "hidden",
        "workbench.colorTheme": "Default Dark Modern",
        "workbench.editor.highlightModifiedTabs": true,
        "workbench.layoutControl.enabled": false,
        "workbench.startupEditor": "none",
        "workbench.statusBar.visible": false,
        "workbench.tips.enabled": false,
        "workbench.welcomePage.walkthroughs.openOnInstall": false,
      },
      defaultLayout: {
        editors: [{ uri: readmeUri }],
        force: true,
        views: [{ id: "workbench.view.explorer" }],
      },
      messagePorts: new Map([[EXTENSION_ID, channel.port1]]),
      productConfiguration: {
        extensionEnabledApiProposals: { [EXTENSION_ID]: ["ipc"] },
      },
      profile: minimalProfile(),
      workspaceProvider: {
        trusted: true,
        workspace: { folderUri },
        open: () => Promise.resolve(true),
      },
    });
  }

  #attachFileSystem(port: MessagePort): void {
    this.#fileSystemPort = port;
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      void this.#handleFileSystemRequest(port, event.data as RpcRequest);
    });
    port.start();
  }

  async #handleFileSystemRequest(
    port: MessagePort,
    request: RpcRequest,
  ): Promise<void> {
    if (typeof request.id !== "number" || typeof request.method !== "string") return;
    try {
      const args = Array.isArray(request.args) ? request.args : [];
      const result = await this.#fileSystemCall(request.method, args);
      if (result instanceof Uint8Array) {
        port.postMessage({ id: request.id, result }, [result.buffer]);
      } else {
        port.postMessage({ id: request.id, result });
      }
    } catch (error) {
      port.postMessage({ id: request.id, error: serializeFileSystemError(error) });
    }
  }

  async #fileSystemCall(method: string, args: unknown[]): Promise<unknown> {
    const sandbox = this.#getSandbox();
    if (!sandbox) throw new Error("the Wasmer sandbox is not running");
    const path = workspacePath(String(args[0] ?? ""));
    if (method === "stat") {
      if (path === ".") {
        const now = this.#mtimes.get(path) ?? Date.now();
        this.#mtimes.set(path, now);
        return { kind: "directory", size: 0, ctime: now, mtime: now };
      }
      const stat = await sandbox.fs.stat(path);
      const now = this.#mtimes.get(path) ?? Date.now();
      this.#mtimes.set(path, now);
      return { ...stat, ctime: now, mtime: now };
    }
    if (method === "readDirectory") {
      return sandbox.fs.readDir(path);
    }
    if (method === "readFile") return sandbox.fs.readFile(path);
    if (method === "writeFile") {
      const contents = args[1];
      if (!(contents instanceof Uint8Array)) throw new Error("invalid file contents");
      await sandbox.fs.writeFile(path, contents);
      this.#mtimes.set(path, Date.now());
      return;
    }
    if (method === "createDirectory") {
      await sandbox.fs.mkdir(path, { recursive: true });
      this.#mtimes.set(path, Date.now());
      return;
    }
    if (method === "delete") {
      await sandbox.fs.remove(path, { recursive: args[1] === true });
      this.#mtimes.delete(path);
      return;
    }
    if (method === "rename") {
      const target = workspacePath(String(args[1] ?? ""));
      if (args[2] === true) {
        try {
          await sandbox.fs.remove(target, { recursive: true });
        } catch {
          // The destination normally does not exist.
        }
      }
      await sandbox.fs.rename(path, target);
      this.#mtimes.set(target, this.#mtimes.get(path) ?? Date.now());
      this.#mtimes.delete(path);
      return;
    }
    throw new Error(`unsupported filesystem operation: ${method}`);
  }
}

function workspacePath(uriPath: string): string {
  const normalized = `/${uriPath}`.replace(/\/+/g, "/");
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) return normalized.slice(11);
  throw new Error("the editor can only access /workspace");
}

function loadWorkbenchStyles(): void {
  const id = "wasmer-code-oss-styles";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `${WORKBENCH_ROOT}out/vs/workbench/workbench.web.main.css`;
  document.head.append(link);
}

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-workbench-src="${src}"]`,
  );
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    const onLoad = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`unable to load ${src}`)),
      { once: true },
    );
    if (!existing) {
      script.dataset.workbenchSrc = src;
      script.src = src;
      document.head.append(script);
    }
  });
}

function minimalProfile(): { name: string; contents: string } {
  const storage = {
    "workbench.activity.pinnedViewlets2": JSON.stringify([
      { id: "workbench.view.explorer", pinned: true, visible: true, order: 0 },
      { id: "workbench.view.search", pinned: false, visible: false, order: 1 },
      { id: "workbench.view.scm", pinned: false, visible: false, order: 2 },
      { id: "workbench.view.debug", pinned: false, visible: false, order: 3 },
      { id: "workbench.view.extensions", pinned: false, visible: false, order: 4 },
    ]),
    "workbench.explorer.views.state.hidden": JSON.stringify([
      { id: "outline", isHidden: true },
      { id: "timeline", isHidden: true },
      { id: "workbench.explorer.openEditorsView", isHidden: true },
      { id: "workbench.explorer.emptyView", isHidden: false },
      { id: "npm", isHidden: true },
    ]),
    "workbench.panel.hidden": "true",
    "workbench.sideBar.hidden": "false",
  };
  const globalState = JSON.stringify({ storage });
  return {
    name: "Wasmer",
    contents: JSON.stringify({ globalState }),
  };
}

function serializeFileSystemError(error: unknown): {
  code: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  let code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "FILESYSTEM_ERROR";
  if (/not found|no such file|entity not found/.test(lower)) code = "NOT_FOUND";
  else if (/already exists|entity already exists/.test(lower)) code = "ALREADY_EXISTS";
  else if (/not a directory/.test(lower)) code = "NOT_A_DIRECTORY";
  else if (/is a directory/.test(lower)) code = "IS_A_DIRECTORY";
  else if (/permission|access denied/.test(lower)) code = "NO_PERMISSIONS";
  return { code, message };
}
