import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import extract from "extract-zip";

const version = "1.108.2";
const release = "v1";
const archiveName = `vscode-web-${version}.zip`;
const archiveUrl =
  `https://github.com/progrium/vscode-web/releases/download/${release}/${archiveName}`;
const archiveSha256 =
  "bd590b3c889c4b12a21c9e2cabf24a87919d3eb33144cec205d04f04cec83457";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cacheRoot = fileURLToPath(new URL("../.wasmer-workbench/", import.meta.url));
const archivePath = `${cacheRoot}/${archiveName}`;
const target = `${projectRoot}/public/workbench-code`;
const marker = `${target}/out/vs/loader.js`;

if (await exists(marker)) process.exit(0);

await mkdir(cacheRoot, { recursive: true });
if ((await exists(archivePath)) && (await sha256(archivePath)) !== archiveSha256) {
  await rm(archivePath, { force: true });
}
if (!(await exists(archivePath))) {
  const response = await fetch(archiveUrl);
  if (!response.ok || !response.body) {
    throw new Error(`unable to download Code OSS workbench (${response.status})`);
  }
  const partial = `${archivePath}.partial`;
  await rm(partial, { force: true });
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(partial)));
  await rename(partial, archivePath);
}
if ((await sha256(archivePath)) !== archiveSha256) {
  throw new Error("downloaded Code OSS workbench has an unexpected SHA-256 digest");
}

const staging = `${cacheRoot}/extract-${process.pid}`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  await extract(archivePath, { dir: staging });
  await rm(target, { recursive: true, force: true });
  await mkdir(new URL("../public/", import.meta.url), { recursive: true });
  await rename(`${staging}/dist/vscode`, target);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
