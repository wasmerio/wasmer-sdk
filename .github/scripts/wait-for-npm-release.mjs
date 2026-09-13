import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const { name, version } = JSON.parse(
  await readFile(new URL("../../js/package.json", import.meta.url), "utf8"),
);
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
const deadline = Date.now() + 10 * 60_000;
let reason = "version has not appeared in registry metadata";

// npm publish can succeed before processing finishes. Wait for the metadata
// used by installers, then verify the tarball is available before syncing locks.
while (Date.now() < deadline) {
  try {
    const response = await fetch(registryUrl, {
      headers: {
        accept: "application/vnd.npm.install-v1+json",
        "cache-control": "no-cache",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
    const metadata = await response.json();
    const release = metadata.versions?.[version];
    if (release?.dist?.tarball) {
      const tarball = await fetch(release.dist.tarball, {
        method: "HEAD",
        signal: AbortSignal.timeout(15_000),
      });
      if (!tarball.ok) throw new Error(`tarball returned HTTP ${tarball.status}`);
      console.log(`${name}@${version} is available for installation`);
      process.exit(0);
    }
  } catch (error) {
    reason = error.message;
  }
  console.log(`Waiting for ${name}@${version}: ${reason}`);
  await delay(15_000);
}
throw new Error(`${name}@${version} is still unavailable after 10 minutes: ${reason}`);
