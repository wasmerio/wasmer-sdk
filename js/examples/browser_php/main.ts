import { Wasmer } from "@wasmer/sdk/browser";

const status = document.querySelector<HTMLSpanElement>("#status")!;
const preview = document.querySelector<HTMLDivElement>("#preview")!;

try {
  status.textContent = "Registering service worker…";
  const serviceWorker = await navigator.serviceWorker.register(
    import.meta.env.DEV
      ? "/wasmer-service-worker.ts"
      : "/wasmer-service-worker.js",
    { scope: "/", type: "module" },
  );

  status.textContent = "Loading PHP…";
  const wasmer = new Wasmer();
  const sandbox = await wasmer.sandboxes.create({
    packages: ["php/php-32@8.3.2102"],
    network: { mode: "http" },
    files: {
      "index.php": [
        "<!doctype html><meta charset=utf-8>",
        "<style>body{font:18px system-ui;padding:3rem;color:#21182d}code{color:#713caa}</style>",
        "<h1>Hello from PHP <?php echo PHP_VERSION; ?></h1>",
        "<p>This response came from a WASIX process running in your browser.</p>",
        "<p><a href='/details.php'>Open an absolute URL</a></p>",
      ].join(""),
      "details.php": "<h1><?php echo 'The answer is ' . (6 * 7); ?></h1><a href='/'>Home</a>",
    },
  });

  status.textContent = "Starting PHP…";
  const php = await sandbox
    .command("php", ["-S", "0.0.0.0:8080", "-t", "/workspace"])
    .spawn({ stdout: "capture", stderr: "capture" });
  const server = await sandbox.ports.expose(8080, { serviceWorker });
  preview.append(server.createIframe({ title: "PHP preview" }));
  status.textContent = "Listening on port 8080";

  window.addEventListener("pagehide", () => {
    void server.close();
    void php.kill();
    void sandbox.close();
    void wasmer.close();
  });
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}
