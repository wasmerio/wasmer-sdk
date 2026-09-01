#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkPackagePath = resolve(repository, "js/package.json");
const manifests = [
  resolve(repository, "wasmer-sh/package.json"),
  resolve(repository, "wasmer-sh/service-worker/package.json"),
];
const sdkPackage = await readJson(sdkPackagePath);
const sdkName = sdkPackage.name;
const sdkVersion = sdkPackage.version;

if (sdkName !== "@wasmer/sdk") {
  throw new Error(`${sdkPackagePath}: expected @wasmer/sdk, got ${sdkName}`);
}
if (typeof sdkVersion !== "string" || sdkVersion.length === 0) {
  throw new Error(`${sdkPackagePath} does not contain a package version`);
}

if (process.argv.includes("--check")) {
  await checkSynchronizedFiles(sdkVersion);
  console.log(`wasmer-sh resolves @wasmer/sdk ${sdkVersion}`);
} else {
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    manifest.dependencies ??= {};
    delete manifest.dependencies["@wasmer/sdk2"];
    manifest.dependencies[sdkName] = sdkVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await migrateWasmerShImports();
  console.log(`updated wasmer-sh to @wasmer/sdk ${sdkVersion}`);
}

async function checkSynchronizedFiles(version) {
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    assertEqual(
      manifest.dependencies?.["@wasmer/sdk"],
      version,
      `${manifestPath} dependency`,
    );
  }

  const expectedTarball =
    `https://registry.npmjs.org/@wasmer/sdk/-/sdk-${version}.tgz`;
  for (const lockPath of [
    resolve(repository, "wasmer-sh/package-lock.json"),
    resolve(repository, "wasmer-sh/service-worker/package-lock.json"),
  ]) {
    const lock = await readJson(lockPath);
    assertEqual(
      lock.packages?.[""]?.dependencies?.["@wasmer/sdk"],
      version,
      `${lockPath} root dependency`,
    );
    const dependency = lock.packages?.["node_modules/@wasmer/sdk"];
    assertEqual(dependency?.version, version, `${lockPath} package version`);
    assertEqual(dependency?.resolved, expectedTarball, `${lockPath} tarball`);
    if (typeof dependency.integrity !== "string" || dependency.integrity === "") {
      throw new Error(`${lockPath} has no @wasmer/sdk integrity hash`);
    }
    if (dependency.link === true) {
      throw new Error(`${lockPath} still links @wasmer/sdk from the workspace`);
    }
  }

  const pnpmLockPath = resolve(repository, "wasmer-sh/pnpm-lock.yaml");
  const pnpmLock = await readFile(pnpmLockPath, "utf8");
  for (const expected of [
    `specifier: ${version}`,
    `version: ${version}`,
    `'@wasmer/sdk@${version}':`,
  ]) {
    if (!pnpmLock.includes(expected)) {
      throw new Error(`${pnpmLockPath} is missing ${JSON.stringify(expected)}`);
    }
  }
}

async function migrateWasmerShImports() {
  for (const relativePath of [
    "wasmer-sh/README.md",
    "wasmer-sh/src/editor.ts",
    "wasmer-sh/src/main.ts",
    "wasmer-sh/vite.config.ts",
    "wasmer-sh/service-worker/.wasmer/host.ts",
    "wasmer-sh/service-worker/wasmer-service-worker.js",
  ]) {
    const path = resolve(repository, relativePath);
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replaceAll("@wasmer/sdk2", sdkName));
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
