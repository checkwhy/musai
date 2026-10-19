import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { type CaseRecord, CURRENT_SCHEMA_VERSIONS, type ModuleRecord, recordId, versionString } from "@musai/records";
import { type GitContext, initWorkspace, type PutItem, Store } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isOperationError } from "../src/errors.js";
import { type Event, eventsSince } from "../src/events.js";
import { openWorkspace } from "../src/open-workspace.js";

const scope = "default";
const now = fixedClock("2026-01-01T00:00:00.000Z");

function emptyManifest() {
  return {
    protocolVersion: ENVELOPE_PROTOCOL,
    contributions: [],
    sourceTree: { digest: { gitTree: "a".repeat(40) } },
    toolchain: [],
    packages: [],
  };
}

function moduleItem(name: string, version: string): PutItem {
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString(version),
    manifest: emptyManifest(),
    bundle: null,
    build: null,
  };
  return { kind: "module", value: moduleRecord };
}

function caseItem(slug: string): PutItem {
  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "events-test" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  return { kind: "case", value: caseRecord };
}

async function installFixtureModule(store: Store, name: string, version: string): Promise<void> {
  await store.putMany([moduleItem(name, version)]);
}

async function bookEmptyCase(store: Store, slug: string): Promise<void> {
  await store.putMany([caseItem(slug)]);
}

function isModuleEvent(event: Event): boolean {
  return event.kind === "module.installed" || event.kind === "pin.changed";
}

async function refusalOf(pending: Promise<unknown>): Promise<{ reason: string }> {
  const error = await pending.catch((caught: unknown) => caught);
  expect(isOperationError(error)).toBe(true);
  return error as { reason: string };
}

describe("eventsSince", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-events-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    const ctx: GitContext = { gitDir: join(workspace, ".musai") };
    return new Store({ ctx, scope, now });
  }

  test("a workspace with no commits at all returns no events and the empty cursor, and reading from that cursor answers the same", async () => {
    const opened = await openWorkspace({ workspace, scope, now });
    const first = await eventsSince(opened);
    const second = await eventsSince(opened, first.cursor);
    expect(first).toEqual({ events: [], cursor: "" });
    expect(second).toEqual(first);
  });

  test("an install produces exactly one module event, whatever else the scope holds", async () => {
    const store = storeAt();
    await bookEmptyCase(store, "unrelated-case");
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const moduleEvents = (await eventsSince(opened)).events.filter(isModuleEvent);
    expect(moduleEvents).toEqual([{ kind: "module.installed", at: moduleEvents[0]!.at, about: "pack" }]);
  });

  test("a returned cursor read again at an unchanged head yields no events and the same cursor", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const first = await eventsSince(opened);
    expect(first.events).toHaveLength(1);

    const second = await eventsSince(opened, first.cursor);
    expect(second).toEqual({ events: [], cursor: first.cursor });
  });

  test("a second module record for a name already installed reads as a pin change, never a second install", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");
    await installFixtureModule(store, "pack", "2");

    const opened = await openWorkspace({ workspace, scope, now });
    const result = await eventsSince(opened);
    expect(result.events.map((event) => event.kind)).toEqual(["module.installed", "pin.changed"]);
    expect(result.events.every((event) => event.about === "pack")).toBe(true);
  });

  test("reading forward from a cursor already past the first install sees only the pin change after it", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const afterInstall = await eventsSince(opened);

    await installFixtureModule(store, "pack", "2");
    const reopened = await openWorkspace({ workspace, scope, now });
    const afterPin = await eventsSince(reopened, afterInstall.cursor);
    expect(afterPin.events).toEqual([{ kind: "pin.changed", at: afterPin.events[0]!.at, about: "pack" }]);
  });

  test("a cursor naming a commit the folded history does not hold refuses stale in either form, rather than silently restarting from the beginning", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const unheld = "0".repeat(40);
    expect((await refusalOf(eventsSince(opened, unheld))).reason).toBe("stale");
    expect((await refusalOf(eventsSince(opened, `${unheld}:0`))).reason).toBe("stale");
  });

  test("a non-empty cursor of neither form refuses invalid-input rather than stale", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const { cursor } = await eventsSince(opened);
    for (const unparseable of [
      "not-a-cursor",
      cursor.slice(1),
      cursor.toUpperCase(),
      `${cursor}:`,
      `${cursor}:-1`,
      `${cursor}:1.5`,
      `${cursor}:0:0`,
      ` ${cursor}`,
    ]) {
      expect((await refusalOf(eventsSince(opened, unparseable))).reason).toBe("invalid-input");
    }
  });

  test("reading from the empty cursor answers exactly what reading with no cursor answers", async () => {
    const store = storeAt();
    await store.putMany([caseItem("first"), moduleItem("pack", "1")]);
    await installFixtureModule(store, "pack", "2");

    const opened = await openWorkspace({ workspace, scope, now });
    const withNone = await eventsSince(opened);
    expect(withNone.events).toHaveLength(3);
    expect(await eventsSince(opened, "")).toEqual(withNone);
  });

  test("a bare commit sha reads on from the end of that commit", async () => {
    const store = storeAt();
    await store.putMany([caseItem("first"), moduleItem("pack", "1")]);
    const opened = await openWorkspace({ workspace, scope, now });
    const first = await eventsSince(opened);
    expect(first.events.map((event) => event.at)).toEqual([first.cursor, first.cursor]);

    await installFixtureModule(store, "pack", "2");
    const reopened = await openWorkspace({ workspace, scope, now });
    const all = await eventsSince(reopened);
    expect(all.events).toHaveLength(3);
    expect(await eventsSince(reopened, first.cursor)).toEqual({ events: all.events.slice(2), cursor: all.cursor });
  });

  test("a commit sha with a position reads on from after that position within the commit", async () => {
    const store = storeAt();
    await store.putMany([caseItem("first"), moduleItem("pack", "1")]);
    await installFixtureModule(store, "pack", "2");

    const opened = await openWorkspace({ workspace, scope, now });
    const all = await eventsSince(opened);
    const commit = all.events[0]!.at;
    expect(await eventsSince(opened, `${commit}:0`)).toEqual({ events: all.events.slice(1), cursor: all.cursor });
  });

  test("a position at or past the commit's last answers the same rows as the bare commit sha", async () => {
    const store = storeAt();
    await store.putMany([caseItem("first"), moduleItem("pack", "1")]);
    await installFixtureModule(store, "pack", "2");

    const opened = await openWorkspace({ workspace, scope, now });
    const commit = (await eventsSince(opened)).events[0]!.at;
    const bare = await eventsSince(opened, commit);
    expect(bare.events).toHaveLength(1);
    for (const position of ["1", "2", "99999999999"]) {
      expect(await eventsSince(opened, `${commit}:${position}`)).toEqual(bare);
    }
  });

  test("two reads at one head produce byte-identical canonical output", async () => {
    const store = storeAt();
    await installFixtureModule(store, "pack", "1");

    const opened = await openWorkspace({ workspace, scope, now });
    const first = await eventsSince(opened);
    const second = await eventsSince(opened);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
