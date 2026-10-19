import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  pseudonymOf,
  runScenario,
  runScenarioInto,
  SCENARIO_PRINCIPAL,
  type Scenario,
  type ScenarioRun,
  scenarioPath,
  stepInstant,
} from "@musai/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, onTestFailed, test } from "vitest";

const SCENARIO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_PATH = join(REPO_ROOT, "packages", "distribution", "dist", "bin", "mcp.js");
// The first hook runs the steps three times (124 s at load 8.5); the budget is about triple.
const SCENARIO_TIMEOUT = 360_000;

/** The last step's instant, so a session opened after the steps reads no earlier clock. */
const LAST_INSTANT = stepInstant(
  (JSON.parse(await readFile(join(SCENARIO_DIR, "scenario.json"), "utf8")) as Scenario).steps.at(-1)!,
);

interface MintedRecord {
  readonly id: string;
  readonly kind: string;
  readonly record: Record<string, unknown>;
}

interface Booked {
  readonly minted: readonly MintedRecord[];
}

interface Soundchecked {
  readonly claims: readonly { readonly label: string; readonly slot: string }[];
}

interface Listed {
  readonly rows: readonly { readonly slug: string }[];
}

interface Logged {
  readonly events: readonly { readonly kind: string; readonly about: string }[];
}

/** A survey's two claim slots in setlist order: its fault reproduces, and it grades as declared. */
function slotsOf(booked: Booked): { readonly reproduced: string; readonly graded: string } {
  const [, reproduced, graded] = booked.minted;
  return { reproduced: reproduced!.record["slot"] as string, graded: graded!.record["slot"] as string };
}

describe("extending: a pack outside the kernel installs twelve contributions and books, settles, walks and lists its own cases through them", () => {
  let run: ScenarioRun;
  const parsed = <T>(id: string): T => JSON.parse(run.outputs.get(id)!) as T;

  beforeAll(async () => {
    run = await runScenario(SCENARIO_DIR);
  }, SCENARIO_TIMEOUT);

  test("the listing puts the newer cases first and ties by slug, and the pack's own query keeps only the severe ones", () => {
    // owl-3 is booked earlier and nothing later touches it; the other two tie and sort by slug.
    expect(parsed<Listed>("list").rows.map((row) => row.slug)).toEqual(["ant-1", "bat-2", "owl-3"]);
    expect(parsed<Listed>("severe").rows.map((row) => row.slug)).toEqual(["ant-1", "bat-2"]);
  });

  test("each survey's claims settle as its probe decides: owl-3's and bat-2's hold, ant-1's fail", () => {
    const labels = new Map(
      ["soundcheck-owl", "soundcheck-bat", "soundcheck-ant"].flatMap((id) =>
        parsed<Soundchecked>(id).claims.map((claim) => [claim.slot, claim.label] as const),
      ),
    );
    const owl = slotsOf(parsed<Booked>("book-owl"));
    const bat = slotsOf(parsed<Booked>("book-bat"));
    const ant = slotsOf(parsed<Booked>("book-ant"));
    expect(labels.get(owl.reproduced)).toBe("holds");
    expect(labels.get(owl.graded)).toBe("holds");
    expect(labels.get(bat.reproduced)).toBe("holds");
    expect(labels.get(bat.graded)).toBe("holds");
    expect(labels.get(ant.reproduced)).toBe("fails");
    expect(labels.get(ant.graded)).toBe("fails");
    expect(parsed<{ label: string }>("status-graded").label).toBe("holds");
    expect(parsed<{ label: string }>("status-reproduced").label).toBe("fails");
  });

  test("a subscription's run is performed when a claim is put and its receipt folds, though no why walk reaches it, since nothing cites it as evidence", () => {
    // Two builds, three probes and two subscription runs; a refused subscription shows only here.
    const runs = parsed<Logged>("log").events.filter(
      (event) => event.kind === "run.recorded" && run.receipts.has(event.about),
    );
    expect(runs).toHaveLength(7);
  });
});

describe("over the built MCP server, a pack's operation and its query's tool reach the workspace the scenario left", () => {
  let workspace: string;
  let steps: ReadonlyMap<string, unknown>;
  let client: Client;
  let stderr = "";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-extending-mcp-"));
    steps = await runScenarioInto(SCENARIO_DIR, workspace);
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_PATH, "--workspace", workspace, "--scope", "default"],
      env: {
        ...getDefaultEnvironment(),
        PATH: scenarioPath(REPO_ROOT),
        MUSAI_NOW: LAST_INSTANT,
        MUSAI_PRINCIPAL: SCENARIO_PRINCIPAL,
      },
      stderr: "pipe",
    });
    // Shown only when a test fails, so a passing run prints none of the child's warnings.
    transport.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: "musai-extending-test", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    onTestFailed(() => {
      console.error(`the server for ${workspace} wrote on stderr:\n${stderr}`);
    });
  });

  async function eventCount(): Promise<number> {
    const answered = await client.callTool({ name: "events_since", arguments: {} });
    return (answered.structuredContent as { events: readonly unknown[] }).events.length;
  }

  test("the query's tool answers the severe cases' rows, the statement's own three fields", async () => {
    const answered = await client.callTool({ name: "fixture-fieldwork_severe", arguments: { kind: null } });

    const { rows } = answered.structuredContent as { rows: readonly Record<string, unknown>[] };
    expect(new Set(rows.map((row) => row.slug))).toEqual(new Set(["ant-1", "bat-2"]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["id", "kind", "slug"]);
    }
  });

  test("the operation drafts a claim at the slot a booking gives it and asserts it as an agent under the session's principal, after performing its run", async () => {
    const note = "a second probe at owl-3 reproduces the fault";
    const answered = await client.callTool({
      name: "fixture-fieldwork_file-followup",
      arguments: { case: "owl-3", note },
    });

    const { minted, receipts } = answered.structuredContent as {
      minted: readonly MintedRecord[];
      receipts: readonly string[];
    };
    expect(minted.length).toBeGreaterThan(0);
    expect(minted.map((item) => item.kind)).toEqual(["claim", "attestation"]);
    const [claim, attestation] = minted;
    expect(claim!.record["slot"]).toBe(slotsOf(steps.get("book-owl") as Booked).reproduced);
    expect(claim!.record["rendering"]).toBe(note);
    expect(attestation!.record).toMatchObject({
      subject: claim!.id,
      purpose: "asserted",
      via: "model",
      principal: pseudonymOf(SCENARIO_PRINCIPAL),
      principalClass: "agent",
    });
    expect(receipts.length).toBeGreaterThan(0);
  });

  test("the operation's closed input refuses a principal handed in, and writes nothing", async () => {
    const before = await eventCount();

    const answered = await client.callTool({
      name: "fixture-fieldwork_file-followup",
      arguments: { case: "owl-3", note: "filed under someone else's name", principal: "someone-else" },
    });

    expect(answered.isError).toBe(true);
    const [item] = answered.content as readonly { readonly type: string; readonly text: string }[];
    expect(JSON.parse(item!.text)).toMatchObject({
      reason: "invalid-input",
      about: ["fixture-fieldwork_file-followup"],
      detail: expect.stringMatching(/must NOT have additional properties/),
    });
    expect(await eventCount()).toBe(before);
  });
});
