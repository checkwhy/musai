import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  DECLARATIVE_RULE,
  type JsonSchema,
  type OperationContext,
  openWorkspace,
  runHandler,
  validateAgainstSchema,
  validateOperationOutput,
} from "@musai/api-core";
import {
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  idFromPath,
  type KernelError,
  type RecordId,
  type RecordKind,
  recordId,
  recordPath,
} from "@musai/records";
import { type Checkout, fixedClock, generateTestKey, makeCheckout, type TestKey } from "@musai/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { tarGz } from "../src/export/tar.js";
import { untarGz } from "../src/export/untar.js";
import { RERUN_CONFIRMATION_TOOL, rerunWithConfirmation } from "../src/mcp/rerun-tool.js";
import { REGISTRY } from "../src/musai.js";
import { checkRun } from "../src/ops/check.js";
import { bundleExport } from "../src/ops/export.js";
import { bundleRerun } from "../src/ops/rerun.js";
import { workspaceInit } from "../src/ops/workspace.js";
import { commandText } from "../src/text.js";

const scope = "default";
const now = fixedClock("2026-10-05T00:00:00.000Z");
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];

/** An interpreter condition naming one recipe, given as raw JSON text, judged by its exit code. */
function namingRecipe(recipe: string): string {
  const expectation = '{"kind":"exitCodeIs","recipe":"named","value":0}';
  return `{"recipes":[{"name":"named","recipe":${recipe}}],"expectations":[${expectation}]}`;
}

/** What a refused call answered; a call that was not refused fails the test. */
function refusalOf(call: Promise<unknown>): Promise<Pick<KernelError, "reason" | "about" | "message">> {
  return call.then(
    () => expect.unreachable("the call was not refused"),
    ({ reason, about, message }: KernelError) => ({ reason, about, message }),
  );
}

/** Every path under a directory, so a test can say a run left it as it was. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

describe("rerun: a stranger's bundle checked, shown, and performed here only when asked", () => {
  let key: TestKey;
  let scratch: string;
  const checkouts: Checkout[] = [];

  beforeAll(async () => {
    key = await generateTestKey(userInfo().username);
    scratch = await mkdtemp(join(tmpdir(), "musai-rerun-"));
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const checkout of checkouts.splice(0)) {
      await checkout.cleanup();
    }
  });

  async function checkout(content = "hello"): Promise<{ dir: string; context: OperationContext }> {
    const made = await makeCheckout(content);
    checkouts.push(made);
    return { dir: made.dir, context: { workspace: made.dir, scope, now, principalName: key.name, via: "signature" } };
  }

  /** A sender's checked claim exported to the public, written where a receiver can read it. */
  async function exported(name: string, to = "public", command = TRACKED_IS_HELLO): Promise<string> {
    const sender = await checkout();
    await runHandler(workspaceInit, { workspace: sender.dir, key: key.keyPath }, sender.context);
    const checked = await runHandler(checkRun, { statement: "the tracked file says hello", command }, sender.context);
    const out = join(scratch, `${name}.tar.gz`);
    await runHandler(bundleExport, { id: checked.claim, to, out, key: key.keyPath }, sender.context);
    return out;
  }

  /** Lands `value` in the workspace `context` names, the kernel minting its id. */
  async function landed(context: OperationContext, value: ClaimRecord): Promise<RecordId> {
    const opened = await openWorkspace(context);
    try {
      const [id] = await opened.put([{ kind: "claim", value }]);
      return id!;
    } finally {
      opened.close();
    }
  }

  /** A sender's checked claim succeeded at its slot by one whose interpreter condition holds
   * `parameters`, and the files of the checked claim's bundle with that successor beside them. */
  async function unreadable(name: string, parameters: string) {
    const sender = await checkout();
    await runHandler(workspaceInit, { workspace: sender.dir, key: key.keyPath }, sender.context);
    const statement = "the tracked file says hello";
    const checked = await runHandler(checkRun, { statement, command: TRACKED_IS_HELLO }, sender.context);
    const out = join(scratch, `${name}.tar.gz`);
    await runHandler(bundleExport, { id: checked.claim, to: "public", out, key: key.keyPath }, sender.context);
    const opened = await openWorkspace(sender.context);
    try {
      const claim = opened.read(checked.claim as RecordId) as ClaimRecord;
      const conditions = { ...claim.conditions, [DECLARATIVE_RULE]: parameters };
      const [successor] = await opened.put([
        { kind: "claim", value: { ...claim, conditions, supersedes: [checked.claim] } },
      ]);
      const files = untarGz(new Uint8Array(await readFile(out)));
      files.set(recordPath("claim", successor!), await opened.store.readBytes(successor!, "claim"));
      return { sender, claim, successor: successor!, files };
    } finally {
      opened.close();
    }
  }

  /** `files` written as a bundle a receiver reads. */
  async function written(name: string, files: ReadonlyMap<string, Uint8Array>): Promise<string> {
    const bundle = join(scratch, `${name}.tar.gz`);
    await writeFile(bundle, tarGz(new Map(files)));
    return bundle;
  }

  const UNREADABLE = [
    ["does not parse", '{"recipes": ['],
    ["names recipes as no list", '{"recipes":"named","expectations":[]}'],
    ["names no recipes", '{"expectations":[]}'],
    ["names a recipe as nothing", '{"recipes":[null],"expectations":[]}'],
    ["names expectations as no list", '{"recipes":[],"expectations":"exitCodeIs"}'],
    ["names no expectations", '{"recipes":[]}'],
    ["names an expectation as nothing", '{"recipes":[],"expectations":[null]}'],
    ["names a recipe as a number with no canonical form", namingRecipe("1e999")],
    ["names a recipe as a lone surrogate", namingRecipe('"\\ud800"')],
  ] as const;

  test.each(UNREADABLE)(
    "export and rerun refuse by name a claim whose interpreter condition %s, quoting no parser",
    async (shape, broken) => {
      const name = shape.replaceAll(" ", "-");
      const { sender, successor, files } = await unreadable(name, broken);
      const bundle = await written(`${name}-carrying`, files);
      const receiver = await checkout();
      const refused = {
        reason: "invalid-input",
        about: [successor],
        message: `refusing ${successor}: its ${DECLARATIVE_RULE} condition does not read as the interpreter's parameters`,
      };
      const exporting = { id: successor, to: "public", out: join(scratch, `${name}-again.tar.gz`), key: key.keyPath };

      expect(await refusalOf(runHandler(bundleExport, exporting, sender.context))).toEqual(refused);
      expect(await refusalOf(runHandler(bundleRerun, { bundle }, receiver.context))).toEqual(refused);
    },
    180_000,
  );

  test.each(UNREADABLE)(
    "a claim correcting one whose interpreter condition %s exports, carrying what it corrects",
    async (shape, broken) => {
      const name = shape.replaceAll(" ", "-");
      const { sender, claim, successor } = await unreadable(`corrected-${name}`, broken);
      const corrected = await landed(sender.context, { ...claim, supersedes: [successor] });
      const out = join(scratch, `corrected-${name}-export.tar.gz`);

      await runHandler(bundleExport, { id: corrected, to: "public", out, key: key.keyPath }, sender.context);
      const carried = [...untarGz(new Uint8Array(await readFile(out))).keys()];

      expect(carried).toContain(recordPath("claim", corrected));
      expect(carried).toContain(recordPath("claim", successor));
    },
    180_000,
  );

  test("a bundle carrying a claim whose condition does not read is refused for its signatures and release first", async () => {
    const { successor, files } = await unreadable("refusal-order", '{"recipes": [');
    const [one, two] = [...files.keys()].filter((path) => path.endsWith(".sig"));
    const swapped = new Map(files).set(one!, files.get(two!)!).set(two!, files.get(one!)!);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("bundle.json")));
    const unreleased = new Map(files).set(
      "bundle.json",
      new TextEncoder().encode(JSON.stringify({ ...manifest, root: successor })),
    );
    const receiver = await checkout();

    const bySignature = await written("refusal-order-swapped", swapped);
    expect(await refusalOf(runHandler(bundleRerun, { bundle: bySignature }, receiver.context))).toMatchObject({
      reason: "record-corrupted",
    });
    const byRelease = await written("refusal-order-unreleased", unreleased);
    expect(await refusalOf(runHandler(bundleRerun, { bundle: byRelease }, receiver.context))).toMatchObject({
      reason: "not-authorised",
    });
  }, 180_000);

  test("names the key that signed the release it checked, beside the name the bundle's signers give it", async () => {
    const bundle = await exported("signed-by");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle }, receiver.context);

    expect(output.release?.signer).toEqual({ principal: key.principal, name: key.name });
    expect(bundleRerun.renderText(output)).toContain(`signed by ${key.name} (${key.principal})`);
  }, 180_000);

  test("outside a checkout it names the repository the bundle's claims are about, by its first commit", async () => {
    const bundle = await exported("no-checkout");
    const outside = await mkdtemp(join(tmpdir(), "musai-outside-"));
    try {
      const refusal = await refusalOf(
        runHandler(bundleRerun, { bundle }, { workspace: outside, scope, now, principalName: key.name }),
      );

      expect(refusal.message).toMatch(/first commit is [0-9a-f]{40}/);
      expect(refusal.message).toContain("clone");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 180_000);

  test("says in words whether a run read the receipt's tree, and that a check does not judge output", async () => {
    const bundle = await exported("in-words");
    const receiver = await checkout();
    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);
    const [claim] = output.claims;

    const same = bundleRerun.renderText(output);
    const moved = bundleRerun.renderText({
      ...output,
      claims: [{ ...claim!, outputMatches: false, tree: { ...claim!.tree!, here: "0".repeat(40) } }],
    });

    expect(same).toContain("the tree the receipt read");
    expect(moved).toContain("another tree than the receipt read");
    expect(moved).toContain("output differs, which a check does not judge");
  }, 180_000);

  test("without --yes it shows each recipe and the tree it would read, and runs nothing", async () => {
    const bundle = await exported("shown");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle }, receiver.context);

    expect(output.release).toMatchObject({ audience: "public", covered: true });
    expect(output.performed).toBe(false);
    expect(output.claims).toHaveLength(1);
    const [claim] = output.claims;
    expect(claim!.command).toEqual(TRACKED_IS_HELLO);
    expect(claim!.tree?.here).toBe(claim!.tree?.recorded);
    expect(claim!.rerun).toBeNull();
    expect(claim!.verdict).toBe("not-run");
    expect(claim!.verdicts).toEqual({ recorded: "holds", rerun: null, matches: null });
  }, 180_000);

  test("a rerun on the same tree matches the receipt, and leaves the receiver's directory as it was", async () => {
    const bundle = await exported("matches");
    const receiver = await checkout();
    const before = await listing(receiver.dir);

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);

    expect(output.performed).toBe(true);
    expect(output.claims.map((claim) => claim.verdict)).toEqual(["matches"]);
    expect(output.claims[0]!.rerun).toEqual(output.claims[0]!.recorded);
    expect(await listing(receiver.dir)).toEqual(before);
  }, 180_000);

  test("a rerun ending as its receipt did matches by exit code and names both sides holding", async () => {
    const bundle = await exported("both-hold");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);

    expect(output.claims.map((claim) => [claim.verdict, claim.verdicts])).toEqual([
      ["matches", { recorded: "holds", rerun: "holds", matches: true }],
    ]);
    expect(bundleRerun.renderText!(output)).toContain("· exit code matches (0); verdict matches (both hold)");
  }, 180_000);

  test("a failure that changed its exit code differs by exit code, its verdict matching as both fail", async () => {
    const failsByTree = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?1:2)"];
    const bundle = await exported("both-fail", "public", failsByTree);
    const receiver = await checkout("goodbye");

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);

    expect(output.claims.map((claim) => [claim.verdict, claim.verdicts])).toEqual([
      ["differs", { recorded: "fails", rerun: "fails", matches: true }],
    ]);
    expect(bundleRerun.renderText!(output)).toContain("· exit code differs (1 → 2); verdict matches (both fail)");
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 180_000);

  test("a rerun judges by the exit code the claim expects, and names output that moved beside it", async () => {
    const printsTheTime = ["node", "-e", "console.log(process.hrtime.bigint())"];
    const bundle = await exported("timed", "public", printsTheTime);
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);

    expect(output.claims.map((claim) => [claim.verdict, claim.outputMatches])).toEqual([["matches", false]]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 180_000);

  test("a rerun whose command now fails reads differs, and exits as a claim that does not hold", async () => {
    const bundle = await exported("differs");
    const receiver = await checkout("goodbye");

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);

    expect(output.claims[0]!.tree?.here).not.toBe(output.claims[0]!.tree?.recorded);
    expect(output.claims[0]!.rerun?.exitCode).toBe(1);
    expect(output.claims[0]!.verdict).toBe("differs");
    expect(output.claims[0]!.verdicts).toEqual({ recorded: "holds", rerun: "fails", matches: false });
    expect(bundleRerun.renderText!(output)).toContain("· exit code differs (0 → 1); verdict differs (holds → fails)");
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 180_000);

  test("refuses a bundle with one record's bytes changed, and runs nothing", async () => {
    const bundle = await exported("tampered");
    const files = untarGz(new Uint8Array(await readFile(bundle)));
    const claimPath = [...files.keys()].find((path) => path.startsWith("records/claim/"))!;
    files.set(
      claimPath,
      new TextEncoder().encode(new TextDecoder().decode(files.get(claimPath)).replace("hello", "HELLO")),
    );
    const tampered = join(scratch, "tampered-edited.tar.gz");
    await writeFile(tampered, tarGz(files));
    const receiver = await checkout();

    await expect(runHandler(bundleRerun, { bundle: tampered, yes: true }, receiver.context)).rejects.toMatchObject({
      reason: "record-corrupted",
    });
  }, 180_000);

  test("re-runs a bundle holding each salted kind at its version before salts, every id as its bytes digest", async () => {
    const files = untarGz(new Uint8Array(await readFile(await exported("previous-versions"))));
    const claimPath = [...files.keys()].find((path) => path.startsWith("records/claim/"))!;
    const run = idFromPath([...files.keys()].find((path) => path.startsWith("records/run/"))!);
    const {
      kind: _kind,
      schemaVersion: _version,
      ...claimFields
    } = JSON.parse(new TextDecoder().decode(files.get(claimPath))) as Record<string, unknown>;
    for (const path of [...files.keys()]) {
      if (path === "bundle.json" || path === claimPath || path.startsWith("records/attestation/")) {
        files.delete(path);
      }
    }
    const atPrevious = (kind: RecordKind, fields: Record<string, unknown>): RecordId => {
      const record = { ...fields, kind, schemaVersion: CURRENT_SCHEMA_VERSIONS[kind] - 1 };
      const id = recordId(record);
      files.set(recordPath(kind, id), canonicalBytes(record));
      return id;
    };
    const claim = atPrevious("claim", claimFields);
    atPrevious("argument", {
      target: claim,
      reason: "the receipt is older than the tree",
      evidence: [
        {
          run,
          selector: { module: "musai.core", parser: "exit-code", version: "1", key: "exitCode" },
          item: recordId(0),
        },
      ],
      premises: [],
      supersedes: [],
    });
    atPrevious("ruling", { over: { claim }, verdict: "holds", reason: "it held", brief: run, supersedes: [] });
    const booked = atPrevious("case", {
      slug: "previous-versions",
      type: null,
      claims: [claim],
      preset: { module: "musai.core", contribution: "musai.core/bare", moduleRecord: run },
      projectCommit: "0".repeat(40),
      overrides: {},
      evaluatorVersion: "1",
      supersedes: [],
    });
    atPrevious("artifact", {
      case: booked,
      lifecycle: "drafted",
      content: "Drafted.",
      format: "markdown",
      supersedes: [],
    });
    const placed = join(scratch, "previous-versions-edited.tar.gz");
    await writeFile(placed, tarGz(files));
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle: placed }, receiver.context);

    expect(output.release).toBeNull();
    expect(output.claims.map((each) => [each.statement, each.verdict])).toEqual([
      ["the tracked file says hello", "not-run"],
    ]);
  }, 180_000);

  test("refuses a bundle whose signatures were swapped between its attestations", async () => {
    const bundle = await exported("swapped");
    const files = untarGz(new Uint8Array(await readFile(bundle)));
    const [one, two] = [...files.keys()].filter((path) => path.endsWith(".sig"));
    const first = files.get(one!)!;
    files.set(one!, files.get(two!)!);
    files.set(two!, first);
    const swapped = join(scratch, "swapped-signatures.tar.gz");
    await writeFile(swapped, tarGz(files));
    const receiver = await checkout();

    await expect(runHandler(bundleRerun, { bundle: swapped }, receiver.context)).rejects.toMatchObject({
      reason: "record-corrupted",
    });
  }, 180_000);

  test("refuses a bundle whose manifest names an audience nothing released stands for", async () => {
    const bundle = await exported("unreleased", "peer");
    const files = untarGz(new Uint8Array(await readFile(bundle)));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("bundle.json")));
    files.set("bundle.json", new TextEncoder().encode(JSON.stringify({ ...manifest, audience: "public" })));
    const narrowed = join(scratch, "unreleased-narrowed.tar.gz");
    await writeFile(narrowed, tarGz(files));
    const receiver = await checkout();

    await expect(runHandler(bundleRerun, { bundle: narrowed }, receiver.context)).rejects.toMatchObject({
      reason: "not-authorised",
    });
  }, 180_000);

  test("a rerun's answer is held to its closed output schema, which refuses a stray field anywhere", async () => {
    const bundle = await exported("closed-output");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle, yes: true }, receiver.context);
    const [claim] = output.claims;

    expect(REGISTRY.get("bundle.rerun@3")).toBe(bundleRerun);
    expect(validateOperationOutput(bundleRerun, output)).toEqual({ ok: true });
    for (const stray of [
      { ...output, stray: 1 },
      { ...output, claims: [{ ...claim!, stray: 1 }] },
      { ...output, claims: [{ ...claim!, verdicts: { ...claim!.verdicts, stray: 1 } }] },
      { ...output, claims: [{ ...claim!, recorded: { ...claim!.recorded, stray: 1 } }] },
    ]) {
      expect(validateOperationOutput(bundleRerun, stray)).toMatchObject({ ok: false });
    }
  }, 180_000);

  test("a planned rerun runs nothing even when asked to perform", async () => {
    const bundle = await exported("planned");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle, yes: true }, { ...receiver.context, mode: "plan" });

    expect(output.performed).toBe(false);
  }, 180_000);

  test("over MCP, yes runs nothing until the person at the client chooses to, shown each command", async () => {
    const bundle = await exported("mcp-confirmed");
    const receiver = await checkout();
    const server = { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { answer: "run" } }) };

    const result = await rerunWithConfirmation(REGISTRY, server, receiver.context, { bundle, yes: true });

    expect(server.elicitInput).toHaveBeenCalledOnce();
    expect(server.elicitInput.mock.calls[0]![0].message).toContain(`- ${commandText(TRACKED_IS_HELLO)}`);
    expect((result.structuredContent as { performed: boolean }).performed).toBe(true);
  }, 180_000);

  test("over MCP, a declined confirmation runs nothing", async () => {
    const bundle = await exported("mcp-declined");
    const receiver = await checkout();
    const server = { elicitInput: vi.fn().mockResolvedValue({ action: "decline" }) };

    const result = await rerunWithConfirmation(REGISTRY, server, receiver.context, { bundle, yes: true });

    expect(result.structuredContent).toMatchObject({ performed: false, confirmation: "decline" });
  }, 180_000);

  test("over MCP, the confirming tool's answer is held to its output schema, which refuses a stray field", async () => {
    const bundle = await exported("mcp-closed");
    const receiver = await checkout();
    const server = { elicitInput: vi.fn().mockResolvedValue({ action: "decline" }) };
    const schema = RERUN_CONFIRMATION_TOOL.outputSchema as JsonSchema;

    const answer = (await rerunWithConfirmation(REGISTRY, server, receiver.context, { bundle, yes: true }))
      .structuredContent as { readonly claims: readonly object[]; readonly confirmation: string };
    const [claim] = answer.claims;

    expect(answer.confirmation).toBe("decline");
    expect(validateAgainstSchema(schema, answer)).toEqual({ ok: true });
    for (const stray of [
      { ...answer, stray: 1 },
      { ...answer, confirmation: "run" },
      { ...answer, claims: [{ ...claim!, stray: 1 }] },
    ]) {
      expect(validateAgainstSchema(schema, stray)).toMatchObject({ ok: false });
    }
  }, 180_000);

  test("over MCP, a person who chooses to run nothing runs nothing", async () => {
    const bundle = await exported("mcp-kept");
    const receiver = await checkout();
    const server = { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { answer: "keep" } }) };

    const result = await rerunWithConfirmation(REGISTRY, server, receiver.context, { bundle, yes: true });

    expect(result.structuredContent).toMatchObject({ performed: false, confirmation: "keep" });
  }, 180_000);

  test("over MCP without yes, nothing is asked and nothing runs", async () => {
    const bundle = await exported("mcp-shown");
    const receiver = await checkout();
    const server = { elicitInput: vi.fn() };

    const result = await rerunWithConfirmation(REGISTRY, server, receiver.context, { bundle });

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect((result.structuredContent as { performed: boolean }).performed).toBe(false);
  }, 180_000);
});
