import "./styles.css";

import {
  type CommandSelector,
  type Package,
  type Process,
  type ReadableBytes,
  type Sandbox,
  type WritableBytes,
  Wasmer,
} from "@wasmer/sdk2/browser";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const DEFAULT_PACKAGE = "wasmer/bash";
const DEFAULT_USES = [
  "wasmer/neatvi",
  "python/python",
  "wasmer/edgejs-quickjs@0.1.1",
  "php/php-32",
];
const TRANSCRIPT_LIMIT = 128 * 1024;

interface ShellConfig {
  packageName: string;
  commandName?: string;
  uses: string[];
  args: string[];
}

interface ActiveSession {
  sandbox: Sandbox;
  process?: Process;
  stdin?: WritableBytes;
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
  terminal: requiredElement<HTMLDivElement>("terminal"),
  status: requiredElement<HTMLSpanElement>("session-status"),
  packageName: requiredElement<HTMLSpanElement>("package-name"),
  bootTitle: requiredElement<HTMLHeadingElement>("boot-title"),
  bootDetail: requiredElement<HTMLParagraphElement>("boot-detail"),
  clear: requiredElement<HTMLButtonElement>("clear-button"),
  restart: requiredElement<HTMLButtonElement>("restart-button"),
  retry: requiredElement<HTMLButtonElement>("retry-button"),
};

const config = readConfig(new URLSearchParams(window.location.search));
const wasmer = new Wasmer({ cache: { namespace: "wasmer.sh" } });
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
    selectionBackground: "#5b4b8a80",
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

let activeSession: ActiveSession | undefined;
let generation = 0;
let inputQueue = Promise.resolve();
let pendingProcessInput = "";
let transcript = "";

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
elements.restart.addEventListener("click", () => void start());
elements.retry.addEventListener("click", () => void start());
window.addEventListener("pagehide", () => void dispose());

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
    const [mainPackage, ...uses] = await Promise.all(
      packageNames.map((name) => wasmer.packages.load(name)),
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
      env: {
        HOME: "/workspace",
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

    activeSession = { sandbox };
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
  inputQueue = Promise.resolve();
  if (!session) return;

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
      "\x1b[38;5;141mWelcome to wasmer.sh\x1b[0m",
      "Unix commands, running as WebAssembly inside your browser.",
      "Type \x1b[38;5;81mhelp\x1b[0m for a few ideas.",
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
  };
}

function workspaceFiles(): Record<string, string> {
  return {
    ".bashrc": `# wasmer.sh is a real Bash session. Keep runtime conveniences here
# so Bash—not the browser—owns command parsing and process execution.
PS1='\\[\\033[38;5;141m\\]wasmer\\[\\033[0m\\]@\\[\\033[38;5;81m\\]web\\[\\033[0m\\]:\\[\\033[38;5;117m\\]\\w\\[\\033[0m\\]$ '
HISTFILE=/workspace/.bash_history
`,
    "README.txt": `wasmer.sh
=========

This shell launches real commands from Wasmer packages inside a browser sandbox.

Things to try:
  ls -lah
  cat example.c
  date
  base64 README.txt
  printf "hello from WASIX\\n"
  python -c "print('hello from Python')"
  edge -e "console.log('hello from Edge.js')"
  php -r "echo 'hello from PHP';"

Package data is cached by the browser for faster future starts.
`,
    "example.c": `#include <stdio.h>

int main(void) {
    printf("Hello World from WebAssembly!\\n");
    return 0;
}
`,
    "hello.txt": "Hello from a Wasmer sandbox.\\n",
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
