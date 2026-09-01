export interface BrowserCompatibilityWarning {
  browser: "firefox" | "safari";
  title: string;
  message: string;
}

const FIREFOX_USER_AGENT = /\b(?:Firefox|FxiOS)\/\d/i;
const SAFARI_USER_AGENT = /\bSafari\/\d/i;
const CHROMIUM_USER_AGENT =
  /\b(?:Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|OPR)\/\d/i;

export function detectBrowserCompatibilityWarning(
  userAgent: string,
): BrowserCompatibilityWarning | undefined {
  if (FIREFOX_USER_AGENT.test(userAgent)) {
    return {
      browser: "firefox",
      title: "Firefox support is coming",
      message:
        "We are working on Firefox support, so stay tuned. For now, please use Chrome for the full experience.",
    };
  }

  if (
    SAFARI_USER_AGENT.test(userAgent) &&
    !CHROMIUM_USER_AGENT.test(userAgent)
  ) {
    return {
      browser: "safari",
      title: "Safari is not supported yet",
      message:
        "Safari does not support JSPI yet, which is required to run this site. For now, please use Chrome for the full experience.",
    };
  }

  return undefined;
}
