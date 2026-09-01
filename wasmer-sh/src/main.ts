import "./styles.css";

import {
  type BrowserServer,
  type CommandSelector,
  type Package,
  type Process,
  type ReadableBytes,
  type Sandbox,
  type WritableBytes,
  Wasmer,
  type WispConnectionRequest,
} from "@wasmer/sdk/browser";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { detectBrowserCompatibilityWarning } from "./browser-compatibility";
import { WorkspaceEditor } from "./editor";
import expressReadme from "../workspace/node-express/README.md?raw";
import expressPackage from "../workspace/node-express/package.json?raw";
import expressLockfile from "../workspace/node-express/pnpm-lock.yaml?raw";
import expressServer from "../workspace/node-express/server.js?raw";
import nextPage from "../workspace/next/pages/index.js?raw";
import nextApiHello from "../workspace/next/pages/api/hello.js?raw";
import nextNpmrc from "../workspace/next/.npmrc?raw";
import nextConfig from "../workspace/next/next.config.mjs?raw";
import nextLockfile from "../workspace/next/pnpm-lock.yaml?raw";
import nextPackage from "../workspace/next/package.json?raw";
import nextReadme from "../workspace/next/README.md?raw";
import nodeReadme from "../workspace/node/README.md?raw";
import nodeServer from "../workspace/node/server.js?raw";
import phpIndex from "../workspace/php/index.php?raw";
import phpInfo from "../workspace/php/phpinfo.php?raw";
import phpReadme from "../workspace/php/README.md?raw";
import pythonReadme from "../workspace/python/README.md?raw";
import pythonServer from "../workspace/python/server.py?raw";
import vinextApp from "../workspace/vinext/pages/_app.js?raw";
import vinextPage from "../workspace/vinext/pages/index.js?raw";
import vinextApiHello from "../workspace/vinext/pages/api/hello.js?raw";
import vinextNpmrc from "../workspace/vinext/.npmrc?raw";
import vinextLockfile from "../workspace/vinext/pnpm-lock.yaml?raw";
import vinextPackage from "../workspace/vinext/package.json?raw";
import vinextReadme from "../workspace/vinext/README.md?raw";
import vinextStyles from "../workspace/vinext/styles.css?raw";
import vinextViteConfig from "../workspace/vinext/vite.config.js?raw";
import workspaceReadme from "../workspace/README.md?raw";

const DEFAULT_PACKAGE = "wasmer/bash";
const EDGEJS_PACKAGE = "wasmer/edgejs@0.2.0";
const DEFAULT_USES = [
  "wasmer/neatvi",
  "curl/curl",
  "python/python@=3.13.18",
  EDGEJS_PACKAGE,
  "php/php-32",
];
const TRANSCRIPT_LIMIT = 128 * 1024;
const MINIMUM_PREVIEW_REFRESH_MS = 180;
const PREVIEW_REFRESH_SETTLE_MS = 90;
const PREVIEW_REFRESH_FADE_OUT_MS = 55;
const WISP_STORAGE_KEY = "wasmer.sh:wisp-url";
const WISP_AUTOCONFIGURE_CHANNEL = "wisp-autoconfigure";
const WISP_AUTOCONFIGURE_PATH = "/wisp-autoconfigure/index.html";
const DEFAULT_WISP_URL = "ws://localhost:4000/";
const DEFAULT_SERVICE_WORKER_ORIGIN = "https://default.local.wasmer.site/";
const LOCAL_WISP_COMMAND = "wasmer run wasmer/wisp-server --net";

type WispSetupMode = "deploy" | "local";

class WispDialogCanceledError extends Error {}

interface ShellConfig {
  packageName: string;
  commandName?: string;
  uses: string[];
  args: string[];
  wispUrl?: string;
  serviceWorkerOrigin?: string;
}

interface ActiveSession {
  sandbox: Sandbox;
  process?: Process;
  stdin?: WritableBytes;
  stopWatchingPorts?: () => void;
  preview?: PreviewSession;
  listeningPorts: Set<number>;
  pendingPreviewPorts: Set<number>;
}

interface PreviewSession {
  port: number;
  server: BrowserServer;
  iframe: HTMLIFrameElement;
  id: string;
  url: URL;
}

interface PreviewStateMessage {
  type?: unknown;
  previewId?: unknown;
  url?: unknown;
  canGoBack?: unknown;
  canGoForward?: unknown;
}

interface PreviewLoadingMessage {
  type?: unknown;
  previewId?: unknown;
}

interface WispAutoconfigureMessage {
  type?: unknown;
  version?: unknown;
  endpoint?: unknown;
}

interface DevelopmentShellApi {
  send(data: string): Promise<void>;
  snapshot(): string;
  state(): string;
}

declare global {
  interface Window {
    __wasmerShell?: DevelopmentShellApi;
  }
}

const elements = {
  browserWarning: requiredElement<HTMLElement>("browser-warning"),
  browserWarningTitle: requiredElement<HTMLElement>("browser-warning-title"),
  browserWarningMessage: requiredElement<HTMLElement>("browser-warning-message"),
  browserWarningDismiss: requiredElement<HTMLButtonElement>(
    "browser-warning-dismiss",
  ),
  stage: document.querySelector<HTMLElement>(".shell-stage")!,
  workspaceColumn: requiredElement<HTMLDivElement>("workspace-column"),
  terminal: requiredElement<HTMLDivElement>("terminal"),
  status: requiredElement<HTMLSpanElement>("session-status"),
  liveHttpBadge: requiredElement<HTMLButtonElement>("live-http-badge"),
  liveHttpLabel: requiredElement<HTMLSpanElement>("live-http-label"),
  packageName: requiredElement<HTMLSpanElement>("package-name"),
  bootTitle: requiredElement<HTMLHeadingElement>("boot-title"),
  bootDetail: requiredElement<HTMLParagraphElement>("boot-detail"),
  clear: requiredElement<HTMLButtonElement>("clear-button"),
  restart: requiredElement<HTMLButtonElement>("restart-button"),
  editorButton: requiredElement<HTMLButtonElement>("editor-button"),
  networkButton: requiredElement<HTMLButtonElement>("network-button"),
  editorPanel: requiredElement<HTMLElement>("editor-panel"),
  editorLoading: requiredElement<HTMLDivElement>("editor-loading"),
  editorWorkbench: requiredElement<HTMLDivElement>("editor-workbench"),
  retry: requiredElement<HTMLButtonElement>("retry-button"),
  previewPanel: requiredElement<HTMLElement>("preview-panel"),
  previewContent: requiredElement<HTMLDivElement>("preview-content"),
  previewBack: requiredElement<HTMLButtonElement>("preview-back"),
  previewForward: requiredElement<HTMLButtonElement>("preview-forward"),
  previewRefresh: requiredElement<HTMLButtonElement>("preview-refresh"),
  previewLocationForm: requiredElement<HTMLFormElement>("preview-location-form"),
  previewLocation: requiredElement<HTMLInputElement>("preview-location"),
  previewOpen: requiredElement<HTMLAnchorElement>("preview-open"),
  previewClose: requiredElement<HTMLButtonElement>("preview-close"),
  wispDialog: requiredElement<HTMLDialogElement>("wisp-dialog"),
  wispForm: requiredElement<HTMLFormElement>("wisp-form"),
  wispTitle: requiredElement<HTMLHeadingElement>("wisp-dialog-title"),
  wispDetail: requiredElement<HTMLParagraphElement>("wisp-dialog-detail"),
  wispDeployTab: requiredElement<HTMLButtonElement>("wisp-deploy-tab"),
  wispLocalTab: requiredElement<HTMLButtonElement>("wisp-local-tab"),
  wispDeployPanel: requiredElement<HTMLElement>("wisp-deploy-panel"),
  wispLocalPanel: requiredElement<HTMLElement>("wisp-local-panel"),
  wispDeployButton: requiredElement<HTMLAnchorElement>("wisp-deploy-button"),
  wispDeployInput: requiredElement<HTMLInputElement>("wisp-deploy-url-input"),
  wispLocalCommand: requiredElement<HTMLInputElement>("wisp-local-command"),
  wispCopyButton: requiredElement<HTMLButtonElement>("wisp-copy-button"),
  wispLocalInput: requiredElement<HTMLInputElement>("wisp-local-url-input"),
  wispError: requiredElement<HTMLParagraphElement>("wisp-url-error"),
  wispCancel: requiredElement<HTMLButtonElement>("wisp-cancel-button"),
};

showBrowserCompatibilityWarning(navigator.userAgent);

const config = readConfig(new URLSearchParams(window.location.search));
const wispAutoconfigureChannel = new BroadcastChannel(
  WISP_AUTOCONFIGURE_CHANNEL,
);
elements.wispDeployButton.href = createWispDeploymentUrl();
const wasmer = new Wasmer({
  cache: { namespace: "wasmer.sh" },
  parallelism: 4,
});
const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: true,
  cursorBlink: true,
  cursorStyle: "bar",
  drawBoldTextInBrightColors: true,
  fontFamily:
    '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
  fontSize: 14,
  fontWeight: "400",
  fontWeightBold: "600",
  letterSpacing: 0,
  lineHeight: 1.24,
  minimumContrastRatio: 4.5,
  scrollback: 5_000,
  theme: {
    background: "#0c0c12",
    foreground: "#e8e5ed",
    cursor: "#a78bfa",
    cursorAccent: "#0c0c12",
    selectionBackground: "#d8d8df45",
    black: "#17171f",
    red: "#fb7185",
    green: "#5ee6a8",
    yellow: "#facc6b",
    blue: "#81aefc",
    magenta: "#c4a7ff",
    cyan: "#67e8f9",
    white: "#e8e5ed",
    brightBlack: "#696575",
    brightRed: "#fda4af",
    brightGreen: "#86efc0",
    brightYellow: "#fde68a",
    brightBlue: "#a9c7ff",
    brightMagenta: "#ddd0ff",
    brightCyan: "#a5f3fc",
    brightWhite: "#ffffff",
  },
});
const fit = new FitAddon();
const workspaceEditor = new WorkspaceEditor(
  elements.editorWorkbench,
  () => activeSession?.sandbox,
);

let activeSession: ActiveSession | undefined;
let generation = 0;
let inputQueue = Promise.resolve();
let pendingProcessInput = "";
let transcript = "";
let previewRefreshStartedAt = 0;
let previewRefreshTimer: number | undefined;
let pendingWispRequest: Promise<string> | undefined;
let wispSetupMode: WispSetupMode = "deploy";

terminal.loadAddon(fit);
terminal.open(elements.terminal);
fitTerminal();
terminal.focus();

new ResizeObserver(fitTerminal).observe(elements.terminal);
terminal.onData((data) => {
  inputQueue = inputQueue
    .then(() => handleTerminalData(data))
    .catch((error: unknown) => showTerminalError(error));
});
terminal.onResize(({ cols, rows }) => {
  activeSession?.process?.resizeTerminal(cols, rows);
});

elements.clear.addEventListener("click", () => {
  terminal.clear();
  terminal.focus();
});
elements.browserWarningDismiss.addEventListener("click", () => {
  elements.browserWarning.hidden = true;
});
elements.restart.addEventListener("click", () => void start());
elements.editorButton.addEventListener("click", () => void toggleEditor());
elements.networkButton.addEventListener("click", () => void changeWispProxy());
window.addEventListener(
  "keydown",
  (event) => {
    if (event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (
      key === "s" &&
      !elements.editorPanel.hidden &&
      elements.editorWorkbench.contains(event.target as Node)
    ) {
      event.preventDefault();
      event.stopPropagation();
      workspaceEditor.save();
    } else if (
      key === "w" &&
      !elements.editorPanel.hidden &&
      elements.editorWorkbench.contains(event.target as Node)
    ) {
      event.preventDefault();
      event.stopPropagation();
      workspaceEditor.closeActive();
    } else if (
      key === "r" &&
      !elements.previewPanel.hidden &&
      activeSession?.preview
    ) {
      event.preventDefault();
      event.stopPropagation();
      refreshPreview();
    }
  },
  { capture: true },
);
elements.retry.addEventListener("click", () => void start());
elements.liveHttpBadge.addEventListener("click", () => {
  const session = activeSession;
  if (!session) return;
  const port = [...session.listeningPorts].at(-1);
  if (port !== undefined) void openPreview(session, port).catch(showTerminalError);
});
elements.previewClose.addEventListener("click", () => {
  const session = activeSession;
  if (session) void closePreview(session);
});
elements.previewBack.addEventListener("click", () => sendPreviewCommand("back"));
elements.previewForward.addEventListener("click", () =>
  sendPreviewCommand("forward"),
);
elements.previewRefresh.addEventListener("click", refreshPreview);
elements.previewLocationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  navigatePreview(elements.previewLocation.value);
});
elements.previewLocation.addEventListener("focus", () => {
  elements.previewLocation.select();
});
elements.wispDeployTab.addEventListener("click", () =>
  selectWispSetup("deploy"),
);
elements.wispLocalTab.addEventListener("click", () =>
  selectWispSetup("local"),
);
elements.wispCopyButton.addEventListener("click", () =>
  void copyLocalWispCommand(),
);
wispAutoconfigureChannel.addEventListener(
  "message",
  receiveWispAutoconfiguration,
);
window.addEventListener("message", receivePreviewState);
window.addEventListener("pagehide", () => {
  wispAutoconfigureChannel.close();
  void dispose();
});

if (import.meta.env.DEV) {
  window.__wasmerShell = {
    send: async (data) => {
      inputQueue = inputQueue.then(() => handleTerminalData(data));
      await inputQueue;
    },
    snapshot: () => transcript,
    state: () => document.documentElement.dataset.state ?? "unknown",
  };
}

void start();

async function start(): Promise<void> {
  const currentGeneration = ++generation;
  setBusy(true);
  setState("booting", "Preparing runtime");
  setBootMessage(
    "Starting your shell",
    "Initializing the Wasmer runtime in this browser.",
  );
  elements.retry.hidden = true;
  elements.packageName.textContent = config.packageName;

  try {
    await closeActiveSession();
    transcript = "";
    pendingProcessInput = "";
    terminal.reset();
    fitTerminal();

    assertBrowserCapabilities();
    await wasmer.ready();
    ensureCurrent(currentGeneration);

    const packageNames = [config.packageName, ...config.uses];
    setState("loading", "Loading packages");
    setBootMessage("Loading the shell", describePackageLoad(packageNames));
    const edgejsDevelopmentPackage = import.meta.env.DEV
      ? import.meta.env.VITE_EDGEJS_WEBC_URL?.trim()
      : undefined;
    const [mainPackage, ...uses] = await Promise.all(
      packageNames.map(async (name) => {
        if (name !== EDGEJS_PACKAGE || !edgejsDevelopmentPackage) {
          return wasmer.packages.load(name);
        }
        const response = await fetch(edgejsDevelopmentPackage);
        if (!response.ok) {
          throw new Error(`Unable to load the development Edge.js package (${response.status})`);
        }
        return wasmer.packages.load(new Uint8Array(await response.arrayBuffer()));
      }),
    );
    ensureCurrent(currentGeneration);
    elements.packageName.textContent = mainPackage.id;

    setState("loading", "Creating sandbox");
    setBootMessage(
      "Creating your sandbox",
      "Composing the packages and workspace entirely inside this tab.",
    );
    const sandbox = await wasmer.sandboxes.create({
      packages: [mainPackage, ...uses],
      files: workspaceFiles(),
      network: {
        mode: "wisp",
        url: config.wispUrl,
        requestUrl: requestWispUrl,
      },
      env: {
        HOME: "/workspace",
        PATH: "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.",
        USER: "wasmer",
        LOGNAME: "wasmer",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    if (currentGeneration !== generation) {
      await sandbox.close();
      return;
    }

    const session: ActiveSession = {
      sandbox,
      listeningPorts: new Set(),
      pendingPreviewPorts: new Set(),
    };
    activeSession = session;
    session.stopWatchingPorts = sandbox.ports.onListen(
      (port) => {
        session.listeningPorts.add(port);
        updateLiveHttpBadge(session);
        void openPreview(session, port).catch(showTerminalError);
      },
      {
        onClose: (port) => {
          session.listeningPorts.delete(port);
          updateLiveHttpBadge(session);
          if (session.preview?.port === port) void closePreview(session);
        },
      },
    );
    setBusy(false);
    terminal.focus();

    if (isManagedShell(config)) {
      await runInteractiveShell(currentGeneration, sandbox, mainPackage);
    } else {
      await runPassthrough(currentGeneration, sandbox, mainPackage);
    }
  } catch (error) {
    if (currentGeneration !== generation) return;
    setBusy(false);
    showStartupError(error);
  }
}

async function handleTerminalData(data: string): Promise<void> {
  const session = activeSession;
  if (!session) return;

  if (session.process && session.stdin) {
    await handleProcessInput(data, session.stdin);
    return;
  }
  pendingProcessInput += data;
}

async function runInteractiveShell(
  processGeneration: number,
  sandbox: Sandbox,
  mainPackage: Package,
): Promise<void> {
  const session = activeSession;
  if (!session) return;

  writeWelcome();
  setState("running", "Starting Bash");
  const process = await sandbox
    .command(
      mainPackage,
      ["--noprofile", "--rcfile", "/workspace/.bashrc", "-i"],
      { cwd: "/workspace" },
    )
    .spawn({
      terminal: { columns: terminal.cols, rows: terminal.rows },
      outputBytes: 1024 * 1024,
    });
  if (!process.stdin || !process.stdout || !process.stderr) {
    await process.kill();
    throw new Error("Bash did not expose its requested streams.");
  }

  session.process = process;
  session.stdin = process.stdin;
  const streams = Promise.allSettled([
    pumpOutput(process.stdout),
    pumpOutput(process.stderr),
  ]);
  if (pendingProcessInput) {
    const pending = pendingProcessInput;
    pendingProcessInput = "";
    await handleProcessInput(pending, process.stdin);
  }
  setState("running", "Ready");
  terminal.focus();
  void monitorInteractiveShell(processGeneration, session, process, streams);
}

async function monitorInteractiveShell(
  processGeneration: number,
  session: ActiveSession,
  process: Process,
  streams: Promise<PromiseSettledResult<void>[]>,
): Promise<void> {
  try {
    const output = await process.wait();
    await streams;
    if (processGeneration !== generation || activeSession !== session) return;
    session.process = undefined;
    session.stdin = undefined;
    setState("exited", `Bash exited · ${output.exitCode}`);
    writeTerminal(
      `\r\n\x1b[38;5;244m[Bash ${output.reason} with status ${output.exitCode}]\x1b[0m\r\n`,
    );
  } catch (error) {
    if (processGeneration === generation && activeSession === session) {
      setState("error", "Bash failed");
      showTerminalError(error);
    }
  }
}

async function handleProcessInput(
  data: string,
  stdin: WritableBytes,
): Promise<void> {
  await stdin.write(data);
}

async function runPassthrough(
  processGeneration: number,
  sandbox: Sandbox,
  mainPackage: Package,
): Promise<void> {
  const session = activeSession;
  if (!session) return;
  setState("running", "Running");
  const process = await sandbox
    .command(selectCommand(mainPackage), config.args, {
      cwd: "/workspace",
    })
    .spawn({
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      outputBytes: 1024 * 1024,
    });
  if (!process.stdin || !process.stdout || !process.stderr) {
    await process.kill();
    throw new Error("The process did not expose its requested streams.");
  }
  session.process = process;
  session.stdin = process.stdin;
  const streams = Promise.allSettled([
    pumpOutput(process.stdout),
    pumpOutput(process.stderr),
  ]);
  const output = await process.wait();
  await streams;
  if (processGeneration !== generation) return;
  session.process = undefined;
  session.stdin = undefined;
  setState("exited", `Exited · ${output.exitCode}`);
  writeTerminal(
    `\r\n\x1b[38;5;244m[process ${output.reason} with status ${output.exitCode}]\x1b[0m\r\n`,
  );
}

async function pumpOutput(stream: ReadableBytes): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    appendTranscript(text);
    terminal.write(chunk);
  }
  writeTerminal(decoder.decode());
}

async function closeActiveSession(): Promise<void> {
  const session = activeSession;
  activeSession = undefined;
  updateLiveHttpBadge();
  inputQueue = Promise.resolve();
  if (!session) return;

  session.stopWatchingPorts?.();
  await closePreview(session);

  if (session.process) {
    try {
      await session.process.kill();
      await session.process.wait();
    } catch {
      // The process may have completed between reading and closing the session.
    }
  }
  await session.sandbox.close();
}

async function openPreview(session: ActiveSession, port: number): Promise<void> {
  if (
    activeSession !== session ||
    session.preview?.port === port ||
    session.pendingPreviewPorts.size > 0
  ) {
    return;
  }
  session.pendingPreviewPorts.add(port);
  try {
    await closePreview(session);
    const serviceWorker = getServiceWorkerOrigin();
    const server = await session.sandbox.ports.expose(port, {
      serviceWorker,
    });
    if (activeSession !== session) {
      await server.close();
      return;
    }
    const id = crypto.randomUUID();
    const iframe = createPreviewIframe(server, port, id);
    session.preview = { port, server, iframe, id, url: server.url };
    elements.previewContent.replaceChildren(iframe);
    elements.previewLocation.value = formatPreviewAddress(server.url, port);
    elements.previewOpen.href = server.url.href;
    elements.previewBack.disabled = true;
    elements.previewForward.disabled = true;
    elements.previewPanel.hidden = false;
    elements.stage.classList.add("has-preview");
    updateLiveHttpBadge(session);
    fitTerminal();
    writeTerminal(
      `\r\n\x1b[38;5;81m[web server listening on port ${port} · preview opened]\x1b[0m\r\n`,
    );
  } finally {
    session.pendingPreviewPorts.delete(port);
  }
}

async function closePreview(session: ActiveSession): Promise<void> {
  const preview = session.preview;
  session.preview = undefined;
  cancelPreviewRefresh();
  if (preview) await preview.server.close();
  if (activeSession === session || activeSession === undefined) {
    elements.previewContent.replaceChildren();
    elements.previewPanel.hidden = true;
    elements.stage.classList.remove("has-preview");
    elements.previewLocation.value = "";
    elements.previewBack.disabled = true;
    elements.previewForward.disabled = true;
    updateLiveHttpBadge(activeSession === session ? session : undefined);
    fitTerminal();
  }
}

function updateLiveHttpBadge(session = activeSession): void {
  if (!session || session.listeningPorts.size === 0) {
    elements.liveHttpBadge.hidden = true;
    elements.liveHttpBadge.setAttribute("aria-pressed", "false");
    return;
  }
  const ports = [...session.listeningPorts];
  const port = ports.at(-1)!;
  elements.liveHttpLabel.textContent =
    ports.length === 1 ? `Live HTTP :${port}` : `Live HTTP · ${ports.length}`;
  elements.liveHttpBadge.title = session.preview
    ? `Web preview open on port ${session.preview.port}`
    : `Open web preview on port ${port}`;
  elements.liveHttpBadge.setAttribute(
    "aria-pressed",
    String(session.preview !== undefined),
  );
  elements.liveHttpBadge.hidden = false;
}

async function toggleEditor(): Promise<void> {
  const opening = elements.editorPanel.hidden;
  elements.editorPanel.hidden = !opening;
  elements.workspaceColumn.classList.toggle("has-editor", opening);
  elements.editorButton.setAttribute("aria-pressed", String(opening));
  fitTerminal();
  setTimeout(fitTerminal, 200);
  if (!opening || elements.editorPanel.dataset.ready === "true") return;
  elements.editorPanel.dataset.error = "false";
  elements.editorLoading.textContent = "Loading editor…";
  try {
    await workspaceEditor.load();
    elements.editorPanel.dataset.ready = "true";
  } catch (error) {
    elements.editorPanel.dataset.error = "true";
    elements.editorLoading.textContent = `Editor unavailable: ${describeError(error)}`;
  }
}

function createPreviewIframe(
  server: BrowserServer,
  port: number,
  id: string,
): HTMLIFrameElement {
  const wrapper = new URL("/.wasmer/browser.html", server.url);
  wrapper.searchParams.set("parentOrigin", window.location.origin);
  wrapper.searchParams.set("previewId", id);
  wrapper.searchParams.set("url", server.url.href);
  const iframe = document.createElement("iframe");
  iframe.src = wrapper.href;
  iframe.title = `localhost:${port}`;
  for (const capability of [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-popups",
    "allow-same-origin",
    "allow-scripts",
  ]) {
    iframe.sandbox.add(capability);
  }
  return iframe;
}

function receivePreviewState(event: MessageEvent<unknown>): void {
  const preview = activeSession?.preview;
  if (!preview || event.source !== preview.iframe.contentWindow) return;
  if (event.origin !== preview.server.url.origin) return;
  const message = event.data as (PreviewStateMessage & PreviewLoadingMessage) | null;
  if (
    message?.type === "wasmer-sh:preview-loading" &&
    message.previewId === preview.id
  ) {
    beginPreviewRefresh();
    return;
  }
  if (
    message?.type !== "wasmer-sh:preview-state" ||
    message.previewId !== preview.id ||
    typeof message.url !== "string"
  ) {
    return;
  }
  const url = new URL(message.url);
  if (url.origin !== preview.server.url.origin) return;
  preview.url = url;
  elements.previewLocation.value = formatPreviewAddress(url, preview.port);
  elements.previewOpen.href = url.href;
  elements.previewBack.disabled = message.canGoBack !== true;
  elements.previewForward.disabled = message.canGoForward !== true;
  finishPreviewRefresh();
}

function refreshPreview(): void {
  if (!activeSession?.preview) return;
  beginPreviewRefresh();
  sendPreviewCommand("refresh");
}

function beginPreviewRefresh(): void {
  if (previewRefreshTimer !== undefined) window.clearTimeout(previewRefreshTimer);
  resetPreviewRefreshIcon();
  previewRefreshStartedAt = performance.now();
  elements.previewRefresh.classList.add("refreshing");
  elements.previewRefresh.setAttribute("aria-busy", "true");
  previewRefreshTimer = window.setTimeout(finishPreviewRefresh, 10_000);
}

function finishPreviewRefresh(): void {
  if (!elements.previewRefresh.classList.contains("refreshing")) return;
  if (previewRefreshTimer !== undefined) window.clearTimeout(previewRefreshTimer);
  previewRefreshTimer = undefined;
  const remaining =
    MINIMUM_PREVIEW_REFRESH_MS -
    PREVIEW_REFRESH_SETTLE_MS -
    (performance.now() - previewRefreshStartedAt);
  if (remaining > 0) {
    previewRefreshTimer = window.setTimeout(finishPreviewRefresh, remaining);
    return;
  }
  const icon = elements.previewRefresh.querySelector<SVGSVGElement>("svg");
  const angle = icon ? rotationAngle(getComputedStyle(icon).transform) : 0;
  if (icon) icon.style.transform = `rotate(${angle}deg)`;
  elements.previewRefresh.classList.remove("refreshing");
  if (icon) {
    void icon.getBoundingClientRect();
    icon.style.transition = [
      `transform ${PREVIEW_REFRESH_FADE_OUT_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
      `opacity ${PREVIEW_REFRESH_FADE_OUT_MS}ms ease-out`,
    ].join(", ");
    icon.style.transform = `rotate(${angle + 30}deg)`;
    icon.style.opacity = "0";
  }
  previewRefreshTimer = window.setTimeout(() => {
    if (!icon) {
      elements.previewRefresh.removeAttribute("aria-busy");
      return;
    }
    icon.style.transition = "none";
    icon.style.transform = "rotate(0deg)";
    void icon.getBoundingClientRect();
    const fadeIn = PREVIEW_REFRESH_SETTLE_MS - PREVIEW_REFRESH_FADE_OUT_MS;
    icon.style.transition = `opacity ${fadeIn}ms ease-out`;
    icon.style.opacity = "1";
    previewRefreshTimer = window.setTimeout(() => {
      resetPreviewRefreshIcon();
      elements.previewRefresh.removeAttribute("aria-busy");
    }, fadeIn);
  }, PREVIEW_REFRESH_FADE_OUT_MS);
}

function cancelPreviewRefresh(): void {
  if (previewRefreshTimer !== undefined) window.clearTimeout(previewRefreshTimer);
  previewRefreshTimer = undefined;
  elements.previewRefresh.classList.remove("refreshing");
  elements.previewRefresh.removeAttribute("aria-busy");
  resetPreviewRefreshIcon();
}

function resetPreviewRefreshIcon(): void {
  const icon = elements.previewRefresh.querySelector<SVGSVGElement>("svg");
  if (!icon) return;
  icon.style.removeProperty("transition");
  icon.style.removeProperty("transform");
  icon.style.removeProperty("opacity");
}

function rotationAngle(transform: string): number {
  if (transform === "none") return 0;
  const values = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(",").map(Number);
  if (!values || values.length < 2) return 0;
  const angle = (Math.atan2(values[1]!, values[0]!) * 180) / Math.PI;
  return (angle + 360) % 360;
}

function sendPreviewCommand(
  action: "back" | "forward" | "refresh" | "navigate",
  url?: URL,
): void {
  const preview = activeSession?.preview;
  if (!preview?.iframe.contentWindow) return;
  preview.iframe.contentWindow.postMessage(
    {
      type: "wasmer-sh:preview-command",
      previewId: preview.id,
      action,
      url: url?.href,
    },
    preview.server.url.origin,
  );
}

function navigatePreview(address: string): void {
  const preview = activeSession?.preview;
  if (!preview) return;
  const value = address.trim();
  if (!value) {
    elements.previewLocation.value = formatPreviewAddress(
      preview.url,
      preview.port,
    );
    return;
  }
  let path = value;
  try {
    const entered = new URL(value.includes("://") ? value : `http://${value}`);
    if (entered.hostname === "localhost" && entered.port === String(preview.port)) {
      path = `${entered.pathname}${entered.search}${entered.hash}`;
    } else if (entered.origin === preview.server.url.origin) {
      path = `${entered.pathname}${entered.search}${entered.hash}`;
    }
  } catch {
    // Treat non-URL input as a path on the guest server.
  }
  const url = new URL(path.startsWith("/") ? path : `/${path}`, preview.url);
  if (url.origin !== preview.server.url.origin) return;
  sendPreviewCommand("navigate", url);
  elements.previewLocation.blur();
}

function formatPreviewAddress(url: URL, port: number): string {
  const suffix = `${url.pathname}${url.search}${url.hash}`;
  return `localhost:${port}${suffix === "/" ? "" : suffix}`;
}

function getServiceWorkerOrigin(): string {
  if (config.serviceWorkerOrigin) return config.serviceWorkerOrigin;
  throw new Error(
    "Browser previews require VITE_WASMER_SERVICE_WORKER_ORIGIN to point at the standalone Wasmer HTTP host",
  );
}

async function dispose(): Promise<void> {
  generation += 1;
  try {
    await closeActiveSession();
  } finally {
    await wasmer.close();
  }
}

function writeWelcome(): void {
  writeTerminal(
    [
      "\x1b[38;5;245mWelcome to wasmer.sh\x1b[0m",
      "Run any Wasmer package in your browser with the Wasmer SDK for JavaScript.",
      "Type \x1b[38;5;81mcat README.md\x1b[0m to explore the workspace.",
      "",
    ].join("\r\n"),
  );
}

function writeTerminal(value: string): void {
  if (!value) return;
  appendTranscript(value);
  terminal.write(value);
}

function selectCommand(mainPackage: Package): CommandSelector {
  return config.commandName
    ? mainPackage.command(config.commandName)
    : mainPackage;
}

function isManagedShell(shellConfig: ShellConfig): boolean {
  return (
    shellConfig.packageName === DEFAULT_PACKAGE &&
    shellConfig.commandName === undefined &&
    shellConfig.args.length === 0
  );
}

function readConfig(params: URLSearchParams): ShellConfig {
  const packageName = params.get("package")?.trim() || DEFAULT_PACKAGE;
  const commandName = params.get("command")?.trim() || undefined;
  const uses = params.has("use")
    ? params.getAll("use").map((value) => value.trim()).filter(Boolean)
    : packageName === DEFAULT_PACKAGE
      ? DEFAULT_USES
      : [];
  return {
    packageName,
    commandName,
    uses,
    args: params.getAll("arg"),
    wispUrl:
      params.get("wisp")?.trim() ||
      import.meta.env.VITE_WISP_URL?.trim() ||
      readStoredWispUrl() ||
      undefined,
    serviceWorkerOrigin:
      params.get("httpOrigin")?.trim() ||
      import.meta.env.VITE_WASMER_SERVICE_WORKER_ORIGIN?.trim() ||
      DEFAULT_SERVICE_WORKER_ORIGIN,
  };
}

function readStoredWispUrl(): string | undefined {
  try {
    return localStorage.getItem(WISP_STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function createWispDeploymentUrl(): string {
  const autoconfigureUrl = new URL(
    WISP_AUTOCONFIGURE_PATH,
    window.location.origin,
  ).href;
  return `https://wasmer.io/apps/create?package=wasmer/wisp-server&env%5BWISP_AUTOCONFIGURE%5D=${encodeURIComponent(autoconfigureUrl)}`;
}

function receiveWispAutoconfiguration(
  event: MessageEvent<WispAutoconfigureMessage>,
): void {
  const message = event.data;
  if (
    message?.type !== "wisp-autoconfigure" ||
    message.version !== 1 ||
    typeof message.endpoint !== "string"
  ) {
    return;
  }

  let endpoint: string;
  try {
    endpoint = normalizeWispUrl(message.endpoint);
  } catch {
    return;
  }

  if (elements.wispDialog.open) {
    elements.wispDeployInput.value = endpoint;
    selectWispSetup("deploy");
    elements.wispForm.requestSubmit();
    return;
  }

  try {
    localStorage.setItem(WISP_STORAGE_KEY, endpoint);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  config.wispUrl = endpoint;
  activeSession?.sandbox.network.setWispUrl(endpoint);
}

function requestWispUrl(request: WispConnectionRequest): Promise<string> {
  if (pendingWispRequest) return pendingWispRequest;
  const pending = showWispDialog(request, "connect")
    .then((url) => {
      config.wispUrl = url;
      return url;
    })
    .finally(() => {
      if (pendingWispRequest === pending) pendingWispRequest = undefined;
    });
  pendingWispRequest = pending;
  return pending;
}

async function changeWispProxy(): Promise<void> {
  const session = activeSession;
  if (!session) return;
  try {
    const url = await showWispDialog({ url: config.wispUrl }, "change");
    session.sandbox.network.setWispUrl(url);
    config.wispUrl = url;
  } catch (error) {
    if (!(error instanceof WispDialogCanceledError)) showTerminalError(error);
  } finally {
    terminal.focus();
  }
}

function showWispDialog(
  request: WispConnectionRequest,
  purpose: "connect" | "change",
): Promise<string> {
  const failedUrl = request.url?.trim();
  elements.wispTitle.textContent =
    purpose === "change" ? "Change WISP server" : "Connect a WISP server";
  elements.wispDetail.textContent =
    purpose === "change"
      ? "Choose a new WISP endpoint. Existing network connections will close when you connect."
      : request.error
        ? `The connection to ${failedUrl || "the configured WISP server"} failed. Enter a working WebSocket endpoint to retry.`
        : "This command needs access to the network. Enter a WISP WebSocket endpoint to continue.";
  const localFailure = failedUrl !== undefined && isLocalWispUrl(failedUrl);
  elements.wispDeployInput.value = localFailure ? "" : failedUrl || "";
  elements.wispLocalInput.value = localFailure ? failedUrl : DEFAULT_WISP_URL;
  selectWispSetup(localFailure ? "local" : "deploy");
  elements.wispError.hidden = true;
  elements.wispError.textContent = "";
  elements.wispDialog.showModal();
  queueMicrotask(() => {
    activeWispInput().focus();
    activeWispInput().select();
  });

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      elements.wispForm.removeEventListener("submit", submit);
      elements.wispCancel.removeEventListener("click", cancel);
      elements.wispDialog.removeEventListener("cancel", cancel);
      if (elements.wispDialog.open) elements.wispDialog.close();
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const submit = (event: Event) => {
      event.preventDefault();
      try {
        const endpoint = normalizeWispUrl(activeWispInput().value);
        try {
          localStorage.setItem(WISP_STORAGE_KEY, endpoint);
        } catch {
          // Storage can be unavailable in private or restricted browser contexts.
        }
        finish(() => resolve(endpoint));
      } catch (error) {
        elements.wispError.textContent = describeError(error);
        elements.wispError.hidden = false;
        activeWispInput().focus();
      }
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      finish(() =>
        reject(
          new WispDialogCanceledError(
            "Network connection canceled: no WISP server is configured",
          ),
        ),
      );
    };
    elements.wispForm.addEventListener("submit", submit);
    elements.wispCancel.addEventListener("click", cancel);
    elements.wispDialog.addEventListener("cancel", cancel);
  });
}

function selectWispSetup(mode: WispSetupMode): void {
  wispSetupMode = mode;
  const deploySelected = mode === "deploy";
  elements.wispDeployTab.setAttribute("aria-selected", String(deploySelected));
  elements.wispDeployTab.tabIndex = deploySelected ? 0 : -1;
  elements.wispDeployPanel.hidden = !deploySelected;
  elements.wispLocalTab.setAttribute("aria-selected", String(!deploySelected));
  elements.wispLocalTab.tabIndex = deploySelected ? -1 : 0;
  elements.wispLocalPanel.hidden = deploySelected;
  elements.wispError.hidden = true;
  elements.wispError.textContent = "";
}

function activeWispInput(): HTMLInputElement {
  return wispSetupMode === "deploy"
    ? elements.wispDeployInput
    : elements.wispLocalInput;
}

function isLocalWispUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

async function copyLocalWispCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(LOCAL_WISP_COMMAND);
  } catch {
    elements.wispLocalCommand.select();
    document.execCommand("copy");
  }
  elements.wispCopyButton.textContent = "Copied";
  window.setTimeout(() => {
    elements.wispCopyButton.textContent = "Copy";
  }, 1_500);
}

function normalizeWispUrl(value: string): string {
  const endpoint = new URL(value.trim());
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new TypeError("The WISP URL must start with ws:// or wss://");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint.href;
}

function workspaceFiles(): Record<string, string> {
  return {
    ".bashrc": `# wasmer.sh is a real Bash session. Keep runtime conveniences here
# so Bash—not the browser—owns command parsing and process execution.
PS1='\\[\\033[1;38;5;141m\\]➜\\[\\033[0m\\] \\[\\033[1;38;5;117m\\]\\W\\[\\033[0m\\] \\[\\033[1m\\]$\\[\\033[0m\\] '
HISTFILE=/workspace/.bash_history
`,
    "README.md": workspaceReadme,
    "node/README.md": nodeReadme,
    "node/server.js": nodeServer,
    "node-express/README.md": expressReadme,
    "node-express/package.json": expressPackage,
    "node-express/pnpm-lock.yaml": expressLockfile,
    "node-express/server.js": expressServer,
    "next/README.md": nextReadme,
    "next/.npmrc": nextNpmrc,
    "next/package.json": nextPackage,
    "next/pnpm-lock.yaml": nextLockfile,
    "next/next.config.mjs": nextConfig,
    "next/pages/index.js": nextPage,
    "next/pages/api/hello.js": nextApiHello,
    "vinext/README.md": vinextReadme,
    "vinext/.npmrc": vinextNpmrc,
    "vinext/package.json": vinextPackage,
    "vinext/pnpm-lock.yaml": vinextLockfile,
    "vinext/pages/_app.js": vinextApp,
    "vinext/pages/index.js": vinextPage,
    "vinext/pages/api/hello.js": vinextApiHello,
    "vinext/styles.css": vinextStyles,
    "vinext/vite.config.js": vinextViteConfig,
    "python/README.md": pythonReadme,
    "python/server.py": pythonServer,
    "php/README.md": phpReadme,
    "php/index.php": phpIndex,
    "php/phpinfo.php": phpInfo,
  };
}

function assertBrowserCapabilities(): void {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      "Cross-origin isolation is unavailable. Serve this page with COOP and COEP headers.",
    );
  }
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer is unavailable in this browser.");
  }
}

function showBrowserCompatibilityWarning(userAgent: string): void {
  const warning = detectBrowserCompatibilityWarning(userAgent);
  if (!warning) return;
  elements.browserWarning.dataset.browser = warning.browser;
  elements.browserWarningTitle.textContent = warning.title;
  elements.browserWarningMessage.textContent = warning.message;
  elements.browserWarning.hidden = false;
}

function describePackageLoad(packageNames: string[]): string {
  if (packageNames.length === 1) {
    return `Resolving ${packageNames[0]} and its cached package data.`;
  }
  return `Resolving ${packageNames[0]} with ${packageNames.length - 1} supporting package${packageNames.length === 2 ? "" : "s"}.`;
}

function setBootMessage(title: string, detail: string): void {
  elements.bootTitle.textContent = title;
  elements.bootDetail.textContent = detail;
}

function setState(state: string, status: string): void {
  document.documentElement.dataset.state = state;
  elements.status.textContent = status;
}

function setBusy(busy: boolean): void {
  elements.restart.disabled = busy;
  elements.editorButton.disabled = busy || activeSession === undefined;
  elements.networkButton.disabled = busy || activeSession === undefined;
}

function showStartupError(error: unknown): void {
  setState("error", "Unable to start");
  setBootMessage("The shell could not start", describeError(error));
  elements.retry.hidden = false;
  showTerminalError(error);
}

function showTerminalError(error: unknown): void {
  writeTerminal(
    `\r\n\x1b[38;5;203mwasmer.sh: ${describeError(error)}\x1b[0m\r\n`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fitTerminal(): void {
  requestAnimationFrame(() => {
    try {
      fit.fit();
    } catch {
      // The terminal can be momentarily detached during a page transition.
    }
  });
}

function appendTranscript(value: string): void {
  transcript += value;
  if (transcript.length > TRANSCRIPT_LIMIT) {
    transcript = transcript.slice(-TRANSCRIPT_LIMIT);
  }
}

function ensureCurrent(expectedGeneration: number): void {
  if (expectedGeneration !== generation) {
    throw new DOMException("The shell start was superseded.", "AbortError");
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}
