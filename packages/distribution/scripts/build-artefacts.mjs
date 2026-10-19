#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModuleArtefacts, manifestBytes } from "@musai/devkit";
import { canonicalBytes } from "@musai/records";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module/", import.meta.url));
const ARTEFACTS_DIR = fileURLToPath(new URL("../dist/artefacts/", import.meta.url));

// Every workspace descends from the receipt's commit, so a build-time clock would move every brief.
const PINNED_BUILD_INSTANT = "1970-01-01T00:00:00.000Z";

async function main() {
  const { name, version, bundleBytes, manifest, buildReceipt } = await buildModuleArtefacts(CORE_MODULE_DIR, {
    now: () => PINNED_BUILD_INSTANT,
  });

  await mkdir(ARTEFACTS_DIR, { recursive: true });
  await writeFile(join(ARTEFACTS_DIR, "bundle.js"), bundleBytes);
  await writeFile(join(ARTEFACTS_DIR, "manifest.json"), manifestBytes(manifest));
  await writeFile(join(ARTEFACTS_DIR, "build-receipt.json"), canonicalBytes(buildReceipt));
  await writeFile(join(ARTEFACTS_DIR, "install.json"), canonicalBytes({ name, version }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
