import type { PackageLoadProgress } from "./package-loading";

type PackageProgress = PackageLoadProgress["packages"][number];
type Row = ReturnType<typeof createRow>;

/** Keep rows mounted so indeterminate rings don't restart on each SDK update. */
export class LoadingScreen {
  private sdk!: Row;
  private packages = new Map<string, Row>();

  constructor(private list: HTMLUListElement) {}

  reset(names: readonly string[]): void {
    this.packages.clear();
    this.list.replaceChildren();
    this.sdk = createRow("Wasmer SDK");
    this.sdk.element.classList.add("sdk-loading-row");
    this.list.append(this.sdk.element);
    renderRow(this.sdk, "Initializing", "", null);
    for (const name of new Set(names)) this.packageRow(name);
  }

  sdkReady(): void { renderRow(this.sdk, "Loaded", "", 100, true); }

  update(progress: PackageLoadProgress): void {
    for (const pkg of progress.packages) {
      const row = this.packageRow(pkg.id);
      row.element.dataset.waiting = "false";
      if (pkg.phase !== "resolving") row.element.dataset.pending = "false";
      const ready = pkg.phase === "ready";
      const percent = pkg.download.percent;
      const status = ready ? "Loaded" : pkg.phase === "loading" ? "Preparing" :
        pkg.phase === "resolving" ? "Resolving" : percent === null ? "Downloading" : `${Math.floor(percent)}%`;
      const version = packageVersion(pkg.id);
      const detail = ready ? (pkg.cached ? "Cached" : version) : downloadDetail(pkg) || version;
      renderRow(row, status, detail, ready ? 100 : pkg.phase === "downloading" ? percent : null, ready);
    }
  }

  complete(ids: readonly string[]): void {
    // Also covers older SDKs without progress callbacks and local package sources.
    for (const id of ids) this.packageRow(id);
    for (const [id, row] of this.packages) {
      renderRow(row, "Loaded", row.element.dataset.ready === "true" ? row.detail.textContent! : packageVersion(id), 100, true);
    }
  }

  fail(): void {
    for (const row of [this.sdk, ...this.packages.values()]) {
      if (row.element.dataset.ready === "true") continue;
      row.element.dataset.failed = "true";
      row.status.textContent = "Stopped";
      row.progress.hidden = true;
      row.check.textContent = "–";
      row.check.hidden = false;
    }
  }

  private packageRow(id: string): Row {
    let row = this.packages.get(id);
    if (row) return row;
    // A root's requested version range becomes an exact ID after resolution.
    const pending = [...this.packages].find(([key, value]) =>
      value.element.dataset.pending === "true" && packageName(key) === packageName(id));
    if (pending) {
      this.packages.delete(pending[0]);
      row = pending[1];
      row.element.dataset.pending = "false";
    } else {
      row = createRow(packageName(id));
      row.element.dataset.pending = "true";
      row.element.dataset.waiting = "true";
      renderRow(row, "Waiting", packageVersion(id), null);
      this.list.append(row.element);
    }
    row.element.dataset.package = id;
    row.progress.setAttribute("aria-label", `${id} download`);
    this.packages.set(id, row);
    return row;
  }
}

function createRow(name: string) {
  const element = document.createElement("li");
  element.className = "loading-row";
  const ring = document.createElement("span");
  ring.className = "loading-ring";
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.setAttribute("aria-label", name);
  const check = document.createElement("span");
  check.className = "loading-check";
  check.textContent = "✓";
  check.setAttribute("aria-hidden", "true");
  check.hidden = true;
  ring.append(progress, check);
  const body = document.createElement("span");
  body.className = "loading-row-body";
  const title = document.createElement("span");
  title.className = "loading-row-name";
  title.textContent = name;
  const detail = document.createElement("span");
  detail.className = "loading-row-detail";
  body.append(title, detail);
  const status = document.createElement("span");
  status.className = "loading-row-status";
  element.append(ring, body, status);
  return { element, progress, check, detail, status };
}

function renderRow(row: Row, status: string, detail: string, percent: number | null, ready = false): void {
  row.element.dataset.ready = String(ready);
  row.status.textContent = status;
  row.detail.textContent = detail;
  row.detail.hidden = !detail;
  row.progress.hidden = ready;
  row.check.hidden = !ready;
  if (percent === null) row.progress.removeAttribute("value");
  else row.progress.value = Math.min(100, Math.max(0, percent));
  row.progress.style.setProperty("--value", String(row.progress.value));
}

function packageName(id: string): string { return id.split("@")[0]; }
function packageVersion(id: string): string { return id.split("@")[1]?.replace(/^=/, "") ?? ""; }
function downloadDetail(pkg: PackageProgress): string {
  if (!pkg.download.downloadedBytes && !pkg.download.totalBytes) return "";
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  return pkg.download.totalBytes === null ? `${mb(pkg.download.downloadedBytes)} MB` :
    `${mb(pkg.download.downloadedBytes)} / ${mb(pkg.download.totalBytes)} MB`;
}
