import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdmissionWorkspace,
  type Argument,
  admitEvidenceEdge,
  BRIEF_HOP_LABEL,
  type DerivationSource,
  type EvaluateClaim,
  type EvaluateRuling,
  evaluate,
  formatBriefDecision,
  formatRulingDecision,
  RULING_HOP_LABEL,
  renderText,
  walkWitnesses,
} from "@musai/evaluate";
import { IndexDb } from "@musai/fold";
import {
  ANY_SCOPE,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  exactDecimal,
  type ModuleRecord,
  point,
  type RulingRecord,
  type RunRecipe,
  type RunRecord,
  readStoredRecord,
  recordId,
  recordPath,
  slotFor,
  timestamp,
  validateRecord,
  versionString,
} from "@musai/records";
import { performRecipe, RUNNER_PERFORMER } from "@musai/run";
import { Store } from "@musai/store";
import { type FixtureRepo, fixedClock, fixtureBrief, makeFixtureRepo, pseudonymOf } from "@musai/test-support";
import { mintAttestation, roleMatrix } from "@musai/trust";
import { describe, expect, test } from "vitest";

const CORE_MODULE_PATH = fileURLToPath(new URL("../../core-module/module.ts", import.meta.url));

/** One fixed instant, so every observation carries the same time on every machine. */
const FIXED_INSTANT = "2026-08-30T00:00:00.000Z";
const FIXED_NOW = fixedClock(FIXED_INSTANT);

const CLAIM_TYPE = "kernel.self/mechanism@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["mechanism"] };

/** A `printf` shim echoing its argument; the comment makes two shims byte-different but alike, as
 * a receiver's `printf` may be a different build. */
async function makePrintfShim(dir: string, distinguishingComment: string): Promise<void> {
  const scriptPath = join(dir, "printf");
  const script = ["#!/bin/sh", `# ${distinguishingComment}`, 'exec /usr/bin/printf "$@"', ""].join("\n");
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
}

/** A module record naming only the core whole-run parser, the least admission needs. */
function coreModuleRecord(): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: "musai.core",
    version: versionString("1"),
    manifest: {
      protocolVersion: 1,
      contributions: [
        {
          kind: "parser",
          id: "musai.core/whole-run",
          version: versionString("1"),
          input: true,
          output: true,
          documentation: "selects the observation's whole output under one key",
        },
      ],
      sourceTree: { digest: { gitTree: "c".repeat(40) } },
      toolchain: [{ name: "node", version: versionString("24.0.0") }],
      packages: [],
    },
    bundle: recordId({ marker: "first-case-bundle-never-written" }),
    build: recordId({ marker: "first-case-build-never-written" }),
  };
}

/** The derivation source for a ruled claim: claim, ruling, brief, receipt, as `why` walks it. */
function rulingDerivationSource(
  claimSlot: string,
  rulingId: string,
  briefId: string,
  runId: string,
  principal: string,
): DerivationSource {
  return {
    nodeOf(id) {
      if (id === claimSlot) {
        return { kind: "claim", decidedBy: "ruling", beat: null, childIds: [rulingId] };
      }
      if (id === rulingId) {
        return {
          kind: RULING_HOP_LABEL,
          decidedBy: formatRulingDecision("person", [principal]),
          beat: null,
          childIds: [briefId],
        };
      }
      if (id === briefId) {
        return { kind: BRIEF_HOP_LABEL, decidedBy: formatBriefDecision(), beat: null, childIds: [runId] };
      }
      if (id === runId) {
        return { kind: "run", decidedBy: "run", beat: null, childIds: [] };
      }
      throw new Error(`no description for node id: ${id}`);
    },
  };
}

describe("a case for a currently open question about this project's own kernel", () => {
  test("re-running one recipe under hygiene, changing only the invoking process's own PATH, mints two run records for byte-identical output — booked as a case citing both recorded positions, with a derivation walking from the statement to a receipt this test writes", async () => {
    const repo: FixtureRepo = await makeFixtureRepo("first-case", [CLAIM_DECLARATION]);
    const scratchDirs: string[] = [];
    try {
      const shimDirA = await mkdtemp(join(tmpdir(), "musai-printf-shim-a-"));
      const shimDirB = await mkdtemp(join(tmpdir(), "musai-printf-shim-b-"));
      scratchDirs.push(shimDirA, shimDirB);
      await makePrintfShim(shimDirA, "a printf that only ever runs from this directory");
      await makePrintfShim(shimDirB, "a second copy of the same shim, byte-different, behaviour-identical");

      const recipe: RunRecipe = {
        command: ["printf", "%s", "one recipe, observed twice"],
        workingDirectory: "/",
        environment: {},
        declared: [],
        substrates: [],
        isolation: "hygiene",
      };

      const originalPath = process.env["PATH"];
      let spawnA: Awaited<ReturnType<typeof performRecipe>>;
      let spawnB: Awaited<ReturnType<typeof performRecipe>>;
      try {
        process.env["PATH"] = shimDirA;
        spawnA = await performRecipe(recipe, { now: FIXED_NOW });
        process.env["PATH"] = shimDirB;
        spawnB = await performRecipe(recipe, { now: FIXED_NOW });
      } finally {
        if (originalPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = originalPath;
        }
      }

      // Recipe and output agree; only the machine's resolution of an undeclared binary differed.
      expect(spawnA.observation.output).toBe(spawnB.observation.output);
      expect(spawnA.observation.output).toBe("one recipe, observed twice");
      expect(spawnA.observation.binaries[0]?.name).toBe("printf");
      expect(spawnB.observation.binaries[0]?.name).toBe("printf");
      expect(spawnA.observation.binaries[0]?.digest).not.toBe(spawnB.observation.binaries[0]?.digest);

      // The divergence is the observation's: a digest lives only there, so a recipe stays portable.
      expect(recordId(spawnA.recipe)).toBe(recordId(spawnB.recipe));
      expect(recordId(spawnA.observation.output)).toBe(recordId(spawnB.observation.output));
      expect(JSON.stringify(spawnA.recipe)).not.toContain(spawnA.observation.binaries[0]!.digest);
      expect(JSON.stringify(spawnB.recipe)).not.toContain(spawnB.observation.binaries[0]!.digest);

      const runA: RunRecord = {
        kind: "run",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
        runKind: "run",
        determinism: "nondeterministic",
        performer: RUNNER_PERFORMER,
        recipe: spawnA.recipe,
        observation: spawnA.observation,
        supersedes: [],
      };
      const runB: RunRecord = {
        kind: "run",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
        runKind: "run",
        determinism: "nondeterministic",
        performer: RUNNER_PERFORMER,
        recipe: spawnB.recipe,
        observation: spawnB.observation,
        supersedes: [],
      };

      expect(recordId(runA)).not.toBe(recordId(runB));

      const validation = validateRecord(runA);
      expect(validation.ok).toBe(true);
      const receiptRecord = validation.ok ? validation.record : runA;
      const receiptBytes = canonicalBytes(receiptRecord);
      const receiptId = recordId(receiptRecord);
      // The id digests this machine's binary, so the receipt is a per-run file, never a fixture.
      const receiptRoot = await mkdtemp(join(tmpdir(), "musai-first-case-receipt-"));
      scratchDirs.push(receiptRoot);
      const receiptPath = join(receiptRoot, recordPath("run", receiptId));
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, receiptBytes);

      // The evidence is built from the file on disk, not the value above.
      const readBackBytes = await readFile(receiptPath);
      const readBackRecord = readStoredRecord(new Uint8Array(readBackBytes), receiptId, "run") as RunRecord;
      expect(readBackRecord.observation.output).toBe("one recipe, observed twice");

      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const [runAId] = await store.putMany([{ kind: "run", value: readBackRecord }]);
      await store.putMany([{ kind: "module", value: coreModuleRecord() }]);

      const index = new IndexDb();
      await index.fold(store);

      const workspace: AdmissionWorkspace = { index, store, modulePath: () => CORE_MODULE_PATH };
      const admitted = await admitEvidenceEdge(
        { module: "musai.core", parser: "whole-run", version: versionString("1"), key: "output" },
        runAId!,
        workspace,
      );
      expect(admitted.edge.item).toBe(recordId("one recipe, observed twice"));

      const conditions = { mechanism: "hygiene-binary-resolution" };
      const slot = slotFor(CLAIM_DECLARATION, conditions);
      const claim: ClaimRecord = {
        kind: "claim",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
        type: CLAIM_TYPE,
        about: ["urn:musai:kernel:hygiene-binary-resolution"],
        slot,
        conditions,
        canonical: {
          statement:
            "Re-running one recipe under hygiene, changing only the invoking process's own PATH, mints two run records for byte-identical output.",
        },
        rendering:
          "Binary resolution reads a declared binary against the invoking process's own PATH and records " +
          "the resolved file's digest on the observation. One project-wide written invariant reads this as " +
          "a leak: a run is meant to see a declared environment, never the shell's, and PATH is exactly the " +
          "shell's own value. A separate recorded design decision reads the identical fact the other way: a " +
          "binary is a descriptor with a name and a digest and no locator, portable by name, with the digest " +
          "there for a receiver's observation to differ on — divergence as the point rather than a leak. " +
          "This claim settles neither reading — the evidence below is what a real run under hygiene actually " +
          "produced; a second real run of the identical recipe, from a printf resolved out of a different " +
          "directory, produced a byte-identical output and a differently-identified record.",
        evidence: [admitted.edge],
        exclusiveGroup: null,
      };
      const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);

      const caseRecord: CaseRecord = {
        kind: "case",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
        type: null,
        slug: "hygiene-binary-resolution",
        claims: [claimId!],
        preset: {
          module: "musai.core",
          contribution: "musai.core/default",
          moduleRecord: recordId({ marker: "preset-module" }),
        },
        projectCommit: "0".repeat(40),
        overrides: {},
        evaluatorVersion: versionString("1"),
      };
      await store.putMany([{ kind: "case", value: caseRecord }]);

      const RULING_PRINCIPAL = pseudonymOf("arbiter@example.com");
      const briefRun = fixtureBrief(
        "brief for the hygiene-binary-resolution case, citing the reproduction's own receipt",
        { recipe: { command: ["brief", claimId!], substrates: [] }, reads: [runAId!] },
      );
      const [briefId] = await store.putMany([{ kind: "run", value: briefRun }]);

      const ruling: RulingRecord = {
        kind: "ruling",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { claim: claimId! },
        verdict: "holds",
        reason:
          "A binary is a name-and-digest descriptor, portable by name, with the digest there for a receiver's " +
          "own observation to differ on -- the divergence two honest runs of one recipe produced is by design, " +
          "not a leak. The gap the finding actually uncovered was different: a hygiene run could once reach for " +
          "any binary on the host's own search path, whether or not anything installed had asked for it as " +
          "tooling. A hygiene run now names only a binary some installed module has declared as a requirement, " +
          "refused by name before anything spawns otherwise.",
        brief: briefId!,
      };
      const [rulingId] = await store.putMany([{ kind: "ruling", value: ruling }]);
      const attestation = mintAttestation({
        subject: rulingId!,
        principal: RULING_PRINCIPAL,
        principalClass: "person",
        via: "tty",
        purpose: "made",
        at: FIXED_INSTANT as never,
      });
      await store.putMany([{ kind: "attestation", value: attestation.record }]);

      const argumentId = `${runAId}#output`;
      const argument: Argument = {
        id: argumentId,
        evidenceKind: "receipt",
        scope: point("hygiene-binary-resolution"),
        declaredWeight: exactDecimal("1"),
      };
      const claims: EvaluateClaim[] = [
        { id: slot, applicable: true, overBudget: false, supportingArgumentIds: [argumentId, runAId!] },
      ];
      const argumentsMap = new Map<string, Argument>([[argumentId, argument]]);
      const matrix = roleMatrix([], [], "deadbeef");
      const rulings: EvaluateRuling[] = [
        {
          id: rulingId!,
          claim: slot,
          principal: RULING_PRINCIPAL,
          principalClass: "person",
          scope: ANY_SCOPE,
          authority: "person",
          decidedAt: timestamp(FIXED_INSTANT),
          verdict: "holds",
          briefReads: [runAId!],
        },
      ];
      const result = evaluate({ claims, arguments: argumentsMap, attacks: [], rulings, matrix, floor: null });

      const status = result.statuses.find((entry) => entry.id === slot);
      if (status === undefined) {
        throw new Error(`no status computed for ${slot}`);
      }
      expect(status.status.label).toBe("holds");
      expect(status.status.comparison.via).toBe("ruling");

      const derivation = walkWitnesses(
        result.labelling,
        rulingDerivationSource(slot, rulingId!, briefId!, runAId!, RULING_PRINCIPAL),
        slot,
      );
      const rendered = renderText(derivation);

      expect(derivation.hop.id).toBe(slot);
      expect(derivation.children[0]?.hop.id).toBe(rulingId);
      expect(derivation.children[0]?.children[0]?.hop.id).toBe(briefId);
      expect(derivation.children[0]?.children[0]?.children[0]?.hop.id).toBe(runAId);
      expect(derivation.children[0]?.children[0]?.children[0]?.hop.id).toBe(receiptId);
      expect(rendered).toContain(rulingId!);
      expect(rendered).toContain(briefId!);
      expect(rendered).toContain(runAId!);

      const onDisk = await readFile(receiptPath);
      expect(recordId(readStoredRecord(new Uint8Array(onDisk), receiptId, "run"))).toBe(runAId);

      console.log(`[kernel.self@1 hygiene-binary-resolution] status: ${status.status.label} — ${rendered}`);
    } finally {
      for (const dir of scratchDirs) {
        await rm(dir, { recursive: true, force: true });
      }
      await repo.cleanup();
    }
  });
});
