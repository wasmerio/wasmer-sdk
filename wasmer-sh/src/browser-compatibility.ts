export interface BrowserCompatibilityWarning {
  browser: "ios" | "firefox" | "safari" | "chromium" | "unknown";
  title: string;
  message: string;
}

const FIREFOX_USER_AGENT = /\b(?:Firefox|FxiOS)\/\d/i;
const SAFARI_USER_AGENT = /\bSafari\/\d/i;
const CHROMIUM_USER_AGENT =
  /\b(?:Chrome|HeadlessChrome|Chromium|CriOS|Edg|EdgA|EdgiOS|OPR)\/\d/i;

type JspiWebAssembly = Partial<typeof WebAssembly> & {
  Suspending?: unknown;
  promising?: unknown;
};

export function detectBrowserCompatibilityWarning(
  userAgent: string,
  wasm: JspiWebAssembly | undefined = globalThis.WebAssembly,
  maxTouchPoints = 0,
): BrowserCompatibilityWarning | undefined {
  if (
    typeof wasm?.Suspending === "function" &&
    typeof wasm?.promising === "function"
  ) {
    return undefined;
  }

  // Browser identity only selects upgrade instructions; support is feature-detected.
  // iPadOS can use a desktop Safari user agent, and iOS browsers share WebKit.
  let browser: BrowserCompatibilityWarning["browser"] = "unknown";
  let upgrade =
    "Update to Firefox 153+, Chrome 137+, or Safari 27+ (iOS/iPadOS 27+ on mobile).";
  if (
    /\b(?:iPhone|iPad|iPod)\b/i.test(userAgent) ||
    (/\bMacintosh\b/i.test(userAgent) && maxTouchPoints > 1)
  ) {
    browser = "ios";
    upgrade =
      "Update your device to iOS 27 or iPadOS 27 or later in Settings > General > Software Update.";
  } else if (FIREFOX_USER_AGENT.test(userAgent)) {
    browser = "firefox";
    upgrade = "Update Firefox to version 153 or later.";
  } else if (CHROMIUM_USER_AGENT.test(userAgent)) {
    browser = "chromium";
    upgrade =
      "Update your browser to the latest version (Chrome or Edge 137 or later).";
  } else if (
    SAFARI_USER_AGENT.test(userAgent) &&
    /\bMacintosh\b/i.test(userAgent)
  ) {
    browser = "safari";
    upgrade =
      "Update to Safari 27 or later in System Settings > General > Software Update. It is included with macOS Golden Gate and also available on macOS Tahoe and Sequoia.";
  }

  return {
    browser,
    title: "Browser update required",
    message: `This browser is missing WebAssembly JSPI, which is required to run programs. ${upgrade} Then reload this page.`,
  };
}
