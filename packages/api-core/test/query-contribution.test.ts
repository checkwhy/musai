import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import { type ContributionEntry, recordId, versionString } from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock, manifestWithContributions } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { invokeContribution } from "../src/contribution.js";
import { isOperationError } from "../src/errors.js";
import { openWorkspace } from "../src/open-workspace.js";
import { validateAgainstSchema } from "../src/registry.js";

const MODULE_NAME = "asking";
const now = fixedClock("2026-08-31T00:00:00.000Z");

const QUERY: ContributionEntry = {
  kind: "query",
  id: `${MODULE_NAME}/records`,
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: { kind: { type: ["string", "null"] } },
    statement: "SELECT id, kind FROM records WHERE :kind IS NULL OR kind = :kind ORDER BY id ASC",
    tables: ["records"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: { id: { type: "string" }, kind: { type: "string" } },
        },
      },
    },
  },
  documentation: "the records this workspace holds, by kind",
};

/** A `data` contribution at a point other than a query: read by its own registry, never called. */
const SLOT: ContributionEntry = {
  kind: "slot",
  id: `${MODULE_NAME}/a-slot`,
  version: versionString("1"),
  input: { layers: ["project"], hasDefault: false },
  output: { type: "string" },
  documentation: "a slot declaration",
};

describe("a contribution answered from the fold rather than through a host", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-query-contribution-"));
    await initWorkspace(workspace, { now });
    const gitDir = join(workspace, ".musai");
    const store = new Store({ ctx: { gitDir }, scope: "default", now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installModule(
      MODULE_NAME,
      versionString("1.0.0"),
      manifestWithContributions([SLOT, QUERY]),
      new TextEncoder().encode(`bundle for ${MODULE_NAME}`),
      recordId({ marker: `build-for-${MODULE_NAME}` }),
      store,
      blobStoreOf(workspace),
      index,
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("answers a query's rows under the shape its own output declares", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });

    const answered = await invokeContribution(opened, MODULE_NAME, QUERY, { kind: "module" });

    expect(answered).toMatchObject({ ok: true, diagnostics: [] });
    const rows = (answered as { output: { rows: Array<Record<string, unknown>> } }).output.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["kind"]).toBe("module");
    // A surface checks the answer against the declared output before handing it on.
    expect(
      validateAgainstSchema(QUERY.output as Record<string, unknown>, (answered as { output: unknown }).output).ok,
    ).toBe(true);
  });

  test("binds a parameter the caller left out as nothing, rather than refusing the call", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });

    const answered = await invokeContribution(opened, MODULE_NAME, QUERY, {});

    expect((answered as { output: { rows: unknown[] } }).output.rows).toHaveLength(1);
  });

  test("refuses by name a data contribution at a point nothing invokes", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });

    const refusal = await invokeContribution(opened, MODULE_NAME, SLOT, {}).then(
      (response) => response,
      (error: unknown) => error,
    );

    expect(isOperationError(refusal)).toBe(true);
    if (isOperationError(refusal)) {
      expect(refusal.reason).toBe("no-such-record");
      expect(refusal.about).toEqual([SLOT.id, "slot"]);
    }
  });

  test("validates a call against a parameter schema carrying the statement and the tables, which the validator ignores", () => {
    // The annotations ride on the validating schema and must not change what it admits.
    expect(validateAgainstSchema(QUERY.input as Record<string, unknown>, { kind: "module" }).ok).toBe(true);
    expect(validateAgainstSchema(QUERY.input as Record<string, unknown>, { kind: null }).ok).toBe(true);
    expect(validateAgainstSchema(QUERY.input as Record<string, unknown>, { kind: 7 }).ok).toBe(false);
    expect(validateAgainstSchema(QUERY.input as Record<string, unknown>, { unknown: "x" }).ok).toBe(false);
  });
});
