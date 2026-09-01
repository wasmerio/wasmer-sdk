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
const sdkVersion = sdkPackage.version;

if (typeof sdkVersion !== "string" || sdkVersion.length === 0) {
  throw new Error(`${sdkPackagePath} does not contain a package version`);
}

if (process.argv.includes("--check")) {
  await checkSynchronizedFiles(sdkVersion);
  console.log(`wasmer-sh resolves @wasmer/sdk2 ${sdkVersion}`);
} else {
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    manifest.dependencies ??= {};
    manifest.dependencies["@wasmer/sdk2"] = sdkVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`updated wasmer-sh to @wasmer/sdk2 ${sdkVersion}`);
}

async function checkSynchronizedFiles(version) {
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    assertEqual(
      manifest.dependencies?.["@wasmer/sdk2"],
      version,
      `${manifestPath} dependency`,
    );
  }

  const expectedTarball =
    `https://registry.npmjs.org/@wasmer/sdk2/-/sdk2-${version}.tgz`;
  for (const lockPath of [
    resolve(repository, "wasmer-sh/package-lock.json"),
    resolve(repository, "wasmer-sh/service-worker/package-lock.json"),
  ]) {
    const lock = await readJson(lockPath);
    assertEqual(
      lock.packages?.[""]?.dependencies?.["@wasmer/sdk2"],
      version,
      `${lockPath} root dependency`,
    );
    const dependency = lock.packages?.["node_modules/@wasmer/sdk2"];
    assertEqual(dependency?.version, version, `${lockPath} package version`);
    assertEqual(dependency?.resolved, expectedTarball, `${lockPath} tarball`);
    if (typeof dependency.integrity !== "string" || dependency.integrity === "") {
      throw new Error(`${lockPath} has no @wasmer/sdk2 integrity hash`);
    }
    if (dependency.link === true) {
      throw new Error(`${lockPath} still links @wasmer/sdk2 from the workspace`);
    }
  }

  const pnpmLockPath = resolve(repository, "wasmer-sh/pnpm-lock.yaml");
  const pnpmLock = await readFile(pnpmLockPath, "utf8");
  for (const expected of [
    `specifier: ${version}`,
    `version: ${version}`,
    `'@wasmer/sdk2@${version}':`,
  ]) {
    if (!pnpmLock.includes(expected)) {
      throw new Error(`${pnpmLockPath} is missing ${JSON.stringify(expected)}`);
    }
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
