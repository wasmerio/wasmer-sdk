const params = new URLSearchParams(location.search);
const parentOrigin = params.get("parentOrigin");
const previewId = params.get("previewId");
const requestedUrl = params.get("url");

if (!parentOrigin || !previewId || !requestedUrl) {
  throw new Error("the Wasmer preview is missing its connection parameters");
}

const initialUrl = new URL(requestedUrl, location.origin);
if (initialUrl.origin !== location.origin) {
  throw new Error("the Wasmer preview URL must use the HTTP host origin");
}

interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentEntry?: { url: string | null };
  addEventListener(type: string, listener: () => void): void;
}

interface PreviewCommand {
  type?: unknown;
  previewId?: unknown;
  action?: unknown;
  url?: unknown;
}

const frame = document.createElement("iframe");
frame.title = "Wasmer server page";
frame.setAttribute(
  "sandbox",
  "allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts",
);
frame.src = initialUrl.href;

let observedNavigation: NavigationState | undefined;

frame.addEventListener("load", () => {
  try {
    const child = frame.contentWindow;
    child?.removeEventListener("keydown", refreshWithKeyboard, true);
    child?.addEventListener("keydown", refreshWithKeyboard, true);
  } catch {
    // Some frameworks isolate their document from the preview wrapper.
  }
  observeNavigation();
  reportState();
});
document.body.append(frame);
globalThis.addEventListener("keydown", refreshWithKeyboard, true);

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as PreviewCommand | null;
  if (
    event.source !== parent ||
    event.origin !== parentOrigin ||
    message?.type !== "wasmer-sh:preview-command" ||
    message.previewId !== previewId
  ) {
    return;
  }
  const child = frame.contentWindow;
  if (!child) return;
  if (message.action === "back") child.history.back();
  else if (message.action === "forward") child.history.forward();
  else if (message.action === "refresh") {
    reportLoading();
    child.location.reload();
  }
  else if (message.action === "navigate" && typeof message.url === "string") {
    const url = new URL(message.url, location.origin);
    if (url.origin === location.origin) child.location.href = url.href;
  }
});

function observeNavigation(): void {
  const navigation = getNavigation();
  if (!navigation || navigation === observedNavigation) return;
  observedNavigation = navigation;
  navigation.addEventListener("currententrychange", reportState);
  navigation.addEventListener("navigatesuccess", reportState);
}

function getNavigation(): NavigationState | undefined {
  try {
    return (frame.contentWindow as (Window & { navigation?: NavigationState }) | null)
      ?.navigation;
  } catch {
    return undefined;
  }
}

function reportState(): void {
  const child = frame.contentWindow;
  if (!child) return;
  const navigation = getNavigation();
  let url = frame.src;
  let canGoBack = false;
  try {
    url = navigation?.currentEntry?.url ?? child.location.href;
    canGoBack = navigation?.canGoBack ?? child.history.length > 1;
  } catch {
    // The URL loaded by the wrapper remains authoritative cross-origin.
  }
  parent.postMessage(
    {
      type: "wasmer-sh:preview-state",
      previewId,
      url,
      canGoBack,
      canGoForward: navigation?.canGoForward ?? false,
    },
    parentOrigin,
  );
}

function reportLoading(): void {
  parent.postMessage(
    {
      type: "wasmer-sh:preview-loading",
      previewId,
    },
    parentOrigin,
  );
}

function refreshWithKeyboard(event: KeyboardEvent): void {
  if (
    event.altKey ||
    event.shiftKey ||
    (!event.metaKey && !event.ctrlKey) ||
    event.key.toLowerCase() !== "r"
  ) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  reportLoading();
  frame.contentWindow?.location.reload();
}
