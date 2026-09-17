// WKWebView does not expose worker console messages through its public Swift
// API. Forward bounded warnings/errors through the existing worker hierarchy.
export function installDiagnostics() {
  globalThis.__wasmerHandleDiagnostic = (message) => {
    if (message?.kind !== "diagnostic") return false;
    postMessage(message);
    return true;
  };
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      original(...values);
      const message = values.map((value) => {
        if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
        return String(value);
      }).join(" ").slice(0, 8192);
      postMessage({ kind: "diagnostic", message: `[${level}] ${message}` });
    };
  }
}
