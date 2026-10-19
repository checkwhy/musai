import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import { timestamp } from "@musai/records";
import { allowedSignersLine, fixedClock, generateTestKey, writeTrustFile } from "@musai/test-support";
import { briefRender } from "../src/ops/brief.js";
import { caseBook } from "../src/ops/case.js";
import { bundleExport } from "../src/ops/export.js";
import { rulingMake } from "../src/ops/ruling.js";
import { workspaceInit } from "../src/ops/workspace.js";

export const CONFORMANCE_DIR = fileURLToPath(new URL("../../../conformance", import.meta.url));

/** One export a verifier must answer as its row says, at a path under conformance/. */
export interface ExportCase {
  readonly name: string;
  readonly archive: string;
  readonly verdict: "verified" | "failed";
  /** Error and warning codes the export produces, sorted; an informational finding is not listed.
   * */
  readonly codes: readonly string[];
  /** The bundle's digest, as `sha256sum`'s listing of the unpacked tree gives it. */
  readonly digest: string;
  readonly what: string;
}

const PRINCIPAL = "conformance@example.test";
const INSTANT = timestamp("2026-09-29T00:00:00.000Z");

/** A ruling's closure released for the public class and exported, in a workspace removed after the
 * call. */
export async function releasedExport(): Promise<{ row: ExportCase; archive: Uint8Array }> {
  const scratch = mkdtempSync(join(tmpdir(), "musai-conformance-export-"));
  const workspace = join(scratch, "workspace");
  const key = await generateTestKey(PRINCIPAL);
  try {
    const context = {
      workspace,
      scope: "default",
      now: fixedClock(INSTANT),
      via: "tty",
      principalName: PRINCIPAL,
    } as const;
    await runHandler(workspaceInit, { workspace }, context);
    const gitDir = join(workspace, ".musai");
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    await writeTrustFile({ gitDir }, "config.json", JSON.stringify({ signing: "person" }));

    const booked = await runHandler(caseBook, { slug: "exported", about: ["https://example.test/exported"] }, context);
    const claim = booked.minted.find((item) => item.kind === "claim")!.id;
    const { brief } = await runHandler(briefRender, { claim }, context);
    const ruled = await runHandler(
      rulingMake,
      { claim, verdict: "holds", reason: "the export carries its evidence", brief, key: key.keyPath },
      context,
    );
    const ruling = ruled.minted.find((item) => item.kind === "ruling")!.id;
    const out = join(scratch, "released.tar.gz");
    const exported = await runHandler(bundleExport, { id: ruling, to: "public", out, key: key.keyPath }, context);
    return {
      row: {
        name: "released",
        archive: "exports/released.tar.gz",
        verdict: "verified",
        codes: ["ref.pin-absent"],
        digest: exported.digest,
        what: "a ruling exported to the public, which releases it with what it cites and who made it, signed, as the kernel's export writes it; the case its brief read is pinned, not carried",
      },
      archive: new Uint8Array(readFileSync(out)),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(key.dir, { recursive: true, force: true });
  }
}

/** Signatures and the ids downstream of the core module differ per run: the key is made for the
 * run, the build receipt here. */
export async function writeExports(dir: string): Promise<void> {
  const cases = [await releasedExport()];
  rmSync(join(dir, "exports"), { recursive: true, force: true });
  mkdirSync(join(dir, "exports"), { recursive: true });
  for (const { row, archive } of cases) {
    writeFileSync(join(dir, row.archive), archive);
  }
  writeFileSync(
    join(dir, "exports.json"),
    `${JSON.stringify(
      cases.map(({ row }) => row),
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeExports(CONFORMANCE_DIR);
  process.stdout.write(`wrote the conformance exports to ${CONFORMANCE_DIR}\n`);
}
