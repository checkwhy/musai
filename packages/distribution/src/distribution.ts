import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OperationError } from "@musai/api-core";
import type { ModuleArtefacts } from "@musai/devkit";
import type { IndexDb } from "@musai/fold";
import { type InstallModuleResult, installModule } from "@musai/modules";
import { type ModuleManifest, type RunRecord, versionString } from "@musai/records";
import { type BlobStore, packageRootFrom, type Store } from "@musai/store";

/** The core module's build output beside this package, found from the package root so source
 * and `dist/` read one directory; an unbuilt tree is refused by name. */
export async function readDistributionArtefacts(): Promise<ModuleArtefacts> {
  const dir = join(packageRootFrom(import.meta.url), "dist", "artefacts");
  try {
    await access(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperationError({
        reason: "no-such-record",
        about: [dir],
        detail: `no distribution artefacts at ${dir}: the distribution was not built`,
      });
    }
    throw error;
  }

  const [bundleBytes, manifestText, receiptText, installText] = await Promise.all([
    readFile(join(dir, "bundle.js")),
    readFile(join(dir, "manifest.json"), "utf8"),
    readFile(join(dir, "build-receipt.json"), "utf8"),
    readFile(join(dir, "install.json"), "utf8"),
  ]);
  const install = JSON.parse(installText) as { name: string; version: string };
  return {
    name: install.name,
    version: versionString(install.version),
    bundleBytes: new Uint8Array(bundleBytes),
    manifest: JSON.parse(manifestText) as ModuleManifest,
    buildReceipt: JSON.parse(receiptText) as RunRecord,
  };
}

/** Installs the core module with the same two writes a module build makes, in the same order. */
export async function installDistributionModule(
  artefacts: ModuleArtefacts,
  store: Store,
  blobs: BlobStore,
  index: IndexDb,
): Promise<InstallModuleResult> {
  const buildReceiptId = await store.put("run", artefacts.buildReceipt);
  return installModule(
    artefacts.name,
    artefacts.version,
    artefacts.manifest,
    artefacts.bundleBytes,
    buildReceiptId,
    store,
    blobs,
    index,
  );
}
