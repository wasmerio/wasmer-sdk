import type { Sandbox } from "@wasmer/sdk/browser";
import type * as Monaco from "monaco-editor/editor/editor.api.js";

interface OpenFile {
  readonly path: string;
  readonly model: Monaco.editor.ITextModel;
  readonly tab: HTMLDivElement;
  savedVersion: number;
}

interface TreeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export class WorkspaceEditor {
  readonly #container: HTMLElement;
  readonly #getSandbox: () => Sandbox | undefined;
  readonly #files = new Map<string, OpenFile>();
  readonly #treeRows = new Map<string, HTMLButtonElement>();
  #initialization?: Promise<void>;
  #monaco?: typeof Monaco;
  #editor?: Monaco.editor.IStandaloneCodeEditor;
  #tree?: HTMLElement;
  #tabs?: HTMLElement;
  #activePath?: string;

  constructor(container: HTMLElement, getSandbox: () => Sandbox | undefined) {
    this.#container = container;
    this.#getSandbox = getSandbox;
  }

  load(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  save(): void {
    void this.#saveActive();
  }

  closeActive(): void {
    if (this.#activePath) this.#closeFile(this.#activePath);
  }

  async #initialize(): Promise<void> {
    const { monaco, MonacoEditorWorker } = await import("./monaco");
    this.#monaco = monaco;
    (globalThis as typeof globalThis & { MonacoEnvironment?: object }).MonacoEnvironment = {
      getWorker: () => new MonacoEditorWorker(),
    };

    this.#container.replaceChildren();
    const shell = element("div", "workspace-editor");
    const explorer = element("aside", "editor-explorer");
    explorer.setAttribute("aria-label", "Files Explorer");
    const explorerHeader = element("div", "editor-explorer-header");
    explorerHeader.append(element("span", "", "Workspace"));
    const refresh = element("button", "editor-icon-button", "↻");
    refresh.type = "button";
    refresh.title = "Refresh files";
    refresh.setAttribute("aria-label", "Refresh files");
    refresh.addEventListener("click", () => void this.#refreshTree());
    explorerHeader.append(refresh);
    this.#tree = element("div", "editor-tree");
    this.#tree.id = "editor-tree";
    explorer.append(explorerHeader, this.#tree);

    const main = element("section", "editor-main");
    this.#tabs = element("div", "editor-tabs");
    this.#tabs.setAttribute("role", "tablist");
    const editorHost = element("div", "monaco-host");
    main.append(this.#tabs, editorHost);
    shell.append(explorer, main);
    this.#container.append(shell);

    monaco.editor.defineTheme("wasmer-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#09090d",
        "editor.foreground": "#e7e5eb",
        "editor.lineHighlightBackground": "#111116",
        "editor.selectionBackground": "#68687366",
        "editor.inactiveSelectionBackground": "#68687340",
        "editorGutter.background": "#09090d",
        "editorLineNumber.foreground": "#5d5d68",
        "editorLineNumber.activeForeground": "#a9a7b2",
      },
    });
    this.#editor = monaco.editor.create(editorHost, {
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontLigatures: false,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      padding: { top: 12 },
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      theme: "wasmer-dark",
    });
    this.#editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.#saveActive();
    });

    await this.#refreshTree();
    await this.#openFile("README.md");
  }

  async #refreshTree(): Promise<void> {
    const tree = this.#tree;
    const sandbox = this.#getSandbox();
    if (!tree || !sandbox) throw new Error("the Wasmer sandbox is not running");
    const entries = await readDirectory(sandbox, ".");
    this.#treeRows.clear();
    tree.replaceChildren(this.#renderEntries(entries, 0));
    this.#updateExplorerSelection();
  }

  #renderEntries(entries: readonly TreeEntry[], depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = element("button", "editor-tree-row");
      row.type = "button";
      row.style.setProperty("--tree-depth", String(depth));
      row.dataset.path = entry.path;
      row.dataset.kind = entry.kind;
      this.#treeRows.set(entry.path, row);
      const marker = element(
        "span",
        "editor-tree-marker",
        entry.kind === "directory" ? "›" : fileMarker(entry.name),
      );
      row.append(marker, element("span", "editor-tree-name", entry.name));
      fragment.append(row);
      if (entry.kind === "directory") {
        const children = element("div", "editor-tree-children");
        children.hidden = true;
        let loaded = false;
        row.addEventListener("click", async () => {
          if (!loaded) {
            const sandbox = this.#getSandbox();
            if (!sandbox) return;
            children.replaceChildren(
              this.#renderEntries(await readDirectory(sandbox, entry.path), depth + 1),
            );
            loaded = true;
          }
          children.hidden = !children.hidden;
          row.classList.toggle("expanded", !children.hidden);
        });
        fragment.append(children);
      } else {
        row.addEventListener("click", () => void this.#openFile(entry.path));
      }
    }
    return fragment;
  }

  async #openFile(path: string): Promise<void> {
    const monaco = this.#monaco;
    const editor = this.#editor;
    const tabs = this.#tabs;
    const sandbox = this.#getSandbox();
    if (!monaco || !editor || !tabs || !sandbox) return;
    let file = this.#files.get(path);
    if (!file) {
      const contents = await sandbox.fs.readText(path);
      const model = monaco.editor.createModel(
        contents,
        languageFor(path),
        monaco.Uri.parse(`wasmer:///workspace/${path}`),
      );
      const tab = element("div", "editor-tab");
      tab.role = "tab";
      tab.title = path;
      const selectTab = element("button", "editor-tab-select");
      selectTab.type = "button";
      selectTab.append(
        element("span", `editor-file-icon file-${fileKind(path)}`, fileMarker(path)),
        element("span", "editor-tab-label", baseName(path)),
        element("span", "editor-dirty", "●"),
      );
      const closeTab = element("button", "editor-tab-close", "×");
      closeTab.type = "button";
      closeTab.title = `Close ${baseName(path)}`;
      closeTab.setAttribute("aria-label", `Close ${baseName(path)}`);
      tab.append(selectTab, closeTab);
      tabs.append(tab);
      file = { path, model, tab, savedVersion: model.getAlternativeVersionId() };
      this.#files.set(path, file);
      selectTab.addEventListener("click", () => this.#activate(path));
      tab.addEventListener("auxclick", (event) => {
        if (event.button === 1) this.#closeFile(path);
      });
      closeTab.addEventListener("click", () => this.#closeFile(path));
      model.onDidChangeContent(() => this.#updateDirty(file!));
    }
    this.#activate(path);
  }

  #activate(path: string): void {
    const file = this.#files.get(path);
    if (!file || !this.#editor) return;
    this.#activePath = path;
    this.#editor.setModel(file.model);
    for (const candidate of this.#files.values()) {
      const selected = candidate.path === path;
      candidate.tab.classList.toggle("active", selected);
      candidate.tab.setAttribute("aria-selected", String(selected));
    }
    this.#updateExplorerSelection();
    this.#editor.focus();
  }

  #closeFile(path: string): void {
    const file = this.#files.get(path);
    if (!file) return;
    const dirty = file.model.getAlternativeVersionId() !== file.savedVersion;
    if (dirty && !globalThis.confirm(`Discard unsaved changes to ${baseName(path)}?`)) {
      return;
    }
    const paths = [...this.#files.keys()];
    const index = paths.indexOf(path);
    const replacement = paths[index + 1] ?? paths[index - 1];
    const wasActive = this.#activePath === path;
    file.tab.remove();
    file.model.dispose();
    this.#files.delete(path);
    if (wasActive) {
      this.#activePath = undefined;
      if (replacement) this.#activate(replacement);
      else this.#editor?.setModel(null);
    }
    this.#updateExplorerSelection();
  }

  #updateExplorerSelection(): void {
    for (const [path, row] of this.#treeRows) {
      const selected = path === this.#activePath;
      row.classList.toggle("active", selected);
      if (selected) {
        row.setAttribute("aria-current", "true");
        revealTreeRow(row);
      } else {
        row.removeAttribute("aria-current");
      }
    }
  }

  async #saveActive(): Promise<void> {
    const path = this.#activePath;
    const file = path ? this.#files.get(path) : undefined;
    const sandbox = this.#getSandbox();
    if (!file || !sandbox) return;
    const contents = file.model.getValue();
    const savedVersion = file.model.getAlternativeVersionId();
    await sandbox.fs.writeText(file.path, contents);
    file.savedVersion = savedVersion;
    this.#updateDirty(file);
  }

  #updateDirty(file: OpenFile): void {
    const dirty = file.model.getAlternativeVersionId() !== file.savedVersion;
    file.tab.classList.toggle("dirty", dirty);
    file.tab.setAttribute("aria-label", `${baseName(file.path)}${dirty ? ", unsaved" : ""}`);
  }
}

async function readDirectory(sandbox: Sandbox, path: string): Promise<TreeEntry[]> {
  const entries = await sandbox.fs.readDir(path);
  const result = entries.map(
    (entry): TreeEntry => {
      const childPath = path === "." ? entry.name : `${path}/${entry.name}`;
      return {
        name: entry.name,
        path: childPath,
        kind: entry.kind,
      };
    },
  );
  return result.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory"
        ? -1
        : 1,
  );
}

function languageFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({
    cjs: "javascript", css: "css", htm: "html", html: "html", js: "javascript",
    json: "json", jsx: "javascript", md: "markdown", mjs: "javascript", php: "php",
    py: "python", sh: "shell", ts: "typescript", tsx: "typescript",
  }[extension ?? ""] ?? "plaintext");
}

function fileKind(path: string): string {
  return path.split(".").at(-1)?.toLowerCase() ?? "text";
}

function fileMarker(path: string): string {
  const extension = fileKind(path);
  if (["js", "cjs", "mjs", "jsx"].includes(extension)) return "JS";
  if (["ts", "tsx"].includes(extension)) return "TS";
  if (extension === "py") return "PY";
  if (extension === "php") return "PHP";
  if (extension === "json") return "{}";
  if (extension === "md") return "#";
  return "·";
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function revealTreeRow(row: HTMLElement): void {
  let parent = row.parentElement;
  while (parent) {
    if (parent.classList.contains("editor-tree-children")) {
      parent.hidden = false;
      parent.previousElementSibling?.classList.add("expanded");
    }
    parent = parent.parentElement;
  }
  row.scrollIntoView({ block: "nearest" });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}
