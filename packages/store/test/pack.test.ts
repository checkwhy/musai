import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };

function claimNumbered(index: number): ClaimRecord {
  const conditions = { subject: `subject-${index}` };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [`urn:example:${index}`],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: { statement: `claim number ${index}` },
    rendering: `Claim number ${index}.`,
    evidence: [
      {
        run: recordId({ marker: "run" }),
        selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" },
        item: recordId({ marker: "item" }),
      },
    ],
    exclusiveGroup: null,
  };
}

async function looseObjects(gitDir: string): Promise<number> {
  const { stdout } = await execa("git", ["--git-dir", gitDir, "count-objects"]);
  return Number.parseInt(stdout, 10);
}

describe("a store packs itself once its loose objects pass a threshold", () => {
  it("packs after the write that crosses it, prunes nothing a ref does not yet reach, and reads every record", async () => {
    const repo = await makeFixtureRepo("packs-itself", [CLAIM_DECLARATION]);
    try {
      const gitDir = repo.ctx.gitDir;
      const { stdout: dangling } = await execa("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin"], {
        input: "an object no ref reaches yet",
      });
      const store = new Store({ ...repo, ctx: repo.ctx, packThreshold: 12 });
      const ids: Awaited<ReturnType<Store["put"]>>[] = [];
      for (let index = 0; index < 6; index++) {
        ids.push(await store.put("claim", claimNumbered(index)));
      }

      expect(await looseObjects(gitDir)).toBeLessThan(12);
      expect((await readdir(join(gitDir, "objects", "pack"))).some((name) => name.endsWith(".pack"))).toBe(true);
      await execa("git", ["--git-dir", gitDir, "cat-file", "-e", dangling]);
      for (const id of ids) {
        expect((await store.read(id, "claim")).kind).toBe("claim");
      }
    } finally {
      await repo.cleanup();
    }
  });
});
