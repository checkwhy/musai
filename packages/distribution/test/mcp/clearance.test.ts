import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OperationContext } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { createMcpServer } from "@musai/mcp";
import { type Audience, CURRENT_SCHEMA_VERSIONS, type RecordId } from "@musai/records";
import { MUSAI_DIR } from "@musai/store";
import {
  allowedSignersLine,
  blobStoreOf,
  foldedIndex,
  generateTestKey,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import {
  CANARY,
  caseCiting,
  claim,
  emptyWorld,
  now,
  opensshAvailable,
  PUBLISHER,
  receiptEdge,
  restingWorld,
  SCOPE,
  SEALED_ID,
  seal,
  sealAndEvaluate,
  sealedClaim,
  slotOf,
  type World,
  WRITER,
} from "../sealed-world.js";

const SERVER_PATH = fileURLToPath(new URL("../../dist/bin/mcp.js", import.meta.url));
const FIXTURES = ["greeter", "stamper"].map((name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
/** A module offering a prompt and a tool, installed and then sealed. */
const SEALED_MODULE = fileURLToPath(new URL("../fixtures/quiet", import.meta.url));
/** What every tool and prompt the sealed module offers is named, and nothing else. */
const SEALED_MODULE_PROJECTION = "quiet_";
/** Every tool whose operation must be handed a file or directory by path. */
const PATH_TOOLS = [
  "blobs_import",
  "bundle_export",
  "bundle_rerun",
  "hook_stop",
  "module_build",
  "module_new",
  "module_test",
];
/** Every tool working in the author's view worktrees or trust branch, with arguments it takes. */
const AUTHORS_TOOLS: Readonly<Record<string, Record<string, string>>> = {
  case_open: { case: "rests" },
  case_save: { case: "rests" },
  config_get: { key: "tools" },
  config_set: { key: "tools", value: "[]" },
  config_unset: { key: "tools" },
};
/** The path fields an operation may be handed and does without. */
const PATH_FIELDS = ["file", "key", "pluginDir", "sourceGitDir", "workspace"];
/** The principal every call the server relays runs under, granted a role and a signer. */
const CLIENT = "station-client";

/** The records a sweep reaches for, sealed or not, and the withheld ones it never names. */
interface Names {
  readonly sealed: readonly RecordId[];
  readonly derived: RecordId;
  /** Withheld, and named by no request, so no response may carry them. */
  readonly unnamed: readonly RecordId[];
  readonly restsOn: RecordId;
  readonly slots: readonly string[];
  readonly cases: readonly string[];
  readonly files: string;
}

/** One response a client was shown, labelled by the request that drew it. */
interface Answer {
  readonly request: string;
  readonly text: string;
}

type Call = readonly [name: string, args: Record<string, unknown>];

/** A world whose sealed run and sealed claim carry the canary, a case citing both, a sealed case,
 * and the author's evaluation of a claim resting on the run. */
async function sealedWorld(key: TestKey, scratch: string[]): Promise<{ world: World; names: Names }> {
  const world = await restingWorld(key, scratch);
  for (const dir of FIXTURES) {
    await buildModule(dir, world.store, {
      blobs: blobStoreOf(world.workspace),
      index: await foldedIndex(world.store),
      now,
    });
  }
  const sealedModule = await buildModule(SEALED_MODULE, world.store, {
    blobs: blobStoreOf(world.workspace),
    index: await foldedIndex(world.store),
    now,
  });
  const sealsModule = await seal(world, sealedModule.moduleRecordId);
  const [sealsRun, derived] = await sealAndEvaluate(world);
  const [hidden, sealsClaim] = await sealedClaim(world);
  const [, sealedCase] = await world.store.putMany([
    { kind: "case", value: caseCiting("hides", [world.restsOn, hidden!]) },
    { kind: "case", value: caseCiting("sealed-case", [world.restsOn]) },
  ]);
  const sealsCase = await seal(world, sealedCase!);
  const gitDir = join(world.workspace, MUSAI_DIR);
  await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
  const signers = allowedSignersLine(key);
  await writeTrustFile({ gitDir }, "allowed-signers", signers);
  const files = await mkdtemp(join(tmpdir(), "musai-mcp-clearance-files-"));
  scratch.push(files);
  await mkdir(join(files, "plugin"));
  const names: Names = {
    sealed: [SEALED_ID, hidden!],
    derived: derived!,
    unnamed: [sealedCase!, sealedModule.moduleRecordId, sealsRun!, sealsClaim!, sealsCase, sealsModule],
    restsOn: world.restsOn,
    slots: [slotOf("rests-on"), slotOf("hidden")],
    cases: ["rests", "hides", "sealed-case"],
    files,
  };
  await writeNotes(names);
  return { world, names };
}

async function writeNotes(names: Names): Promise<void> {
  const cited = [...names.sealed, names.derived, names.restsOn];
  const sentences = cited.map((_, index) => `A sentence resting on a record.[^n${index}]`).join("\n");
  const footnotes = cited.map((id, index) => `[^n${index}]: ${id}`).join("\n");
  await writeFile(join(names.files, "NOTES.md"), `${sentences}\n\n## Receipts\n\n${footnotes}\n`);
}

/** A contributed operation's plan that cites `id` as evidence, and one that asks for it. */
function plansReaching(id: RecordId): readonly object[] {
  return [
    { put: [{ kind: "claim", value: claim("stamped", {}, [receiptEdge(id)]) }], attest: [], needs: [] },
    { put: [], attest: [], needs: [{ kind: "record", id }] },
  ];
}

/** Each tool's calls, reads before writes; every id a tool takes is tried with each record the
 * sweep names, sealed or not. */
function toolCalls(names: Names, key: TestKey): readonly Call[] {
  const ids = [...names.sealed, names.derived, names.restsOn];
  const claims = [...ids, ...names.slots];
  const notes = join(names.files, "NOTES.md");
  const bundles = claims.map((_, index) => join(names.files, `bundle-${index}.tar.gz`));
  const module = join(names.files, "module");
  const plans = ids.flatMap(plansReaching);
  const parsed = { exitCode: 0, output: SEALED_ID };
  const calls: Record<string, readonly Record<string, unknown>[]> = {
    claim_status: claims.flatMap((claim) => [{ claim, plan: true }, { claim }]),
    claim_why: claims.map((claim) => ({ claim, full: true })),
    case_status: names.cases.map((slug) => ({ case: slug })),
    gate_pending: [{}, ...names.cases.map((slug) => ({ case: slug }))],
    events_since: [{}],
    view_run: [{}],
    musai_core_cases: [{}, { kind: null }],
    render_markdown: [{ file: notes }],
    hook_stop: [{ hook: { transcript_path: notes } }],
    scope_list: [{}],
    key_list: [{}],
    doctor_run: [{}],
    "musai_core_exit-code": [parsed],
    "musai_core_line-range": [parsed],
    musai_core_pointer: [parsed],
    "musai_core_test-report": [parsed],
    "musai_core_whole-run": [parsed],
    greeter_greets: [{ name: SEALED_ID }],
    greeter_note: [{ who: SEALED_ID }],
    "stamper_answers-as-read": plans.map((answer) => ({ answer })),
    brief_render: claims.map((claim) => ({ claim })),
    gate_ask: claims.map((claim) => ({ claim })),
    gate_answer: ids.map((pending) => ({ pending, brief: pending })),
    bundle_export: claims.map((id, index) => ({ id, to: WRITER, out: bundles[index], key: key.keyPath })),
    bundle_rerun: bundles.flatMap((bundle) => [{ bundle }, { bundle, yes: true }]),
    case_open: names.cases.map((slug) => ({ case: slug })),
    case_save: names.cases.map((slug) => ({ case: slug })),
    case_soundcheck: names.cases.map((slug) => ({ case: slug })),
    case_book: [{ slug: "booked-by-the-station" }],
    challenge_file: ids.map((target) => ({
      target,
      reason: "challenged",
      run: SEALED_ID,
      selector: "musai.core/exit-code@1:result",
    })),
    check_run: [{ statement: "node exits cleanly", command: ["node", "-e", "process.exit(0)"] }],
    release_grant: ids.map((id) => ({ id, to: WRITER, key: key.keyPath })),
    release_revoke: ids.map((id) => ({ id, from: WRITER })),
    release_seal: ids.map((id) => ({ id, from: WRITER })),
    ruling_make: claims.map((claim) => ({ claim, verdict: "holds", reason: "ruled", brief: SEALED_ID })),
    stamper_answers: plans.map((answer) => ({ answer })),
    "stamper_answers-irreversibly": plans.map((answer) => ({ answer, plan: true })),
    "stamper_asserts-and-runs": [
      {
        subject: SEALED_ID,
        predicate: "names",
        object: SEALED_ID,
        slot: slotOf("stamped"),
        schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      },
    ],
    module_new: [{ dir: module }],
    module_test: [{ dir: module }],
    module_build: [{ dir: module }],
    blobs_import: [{ dir: names.files }],
    plugin_sync: [{ pluginDir: join(names.files, "plugin") }],
    scope_fork: [{ name: "station-fork" }],
    scope_merge: [{ from: "station-fork" }],
    scope_drop: [{ name: "station-fork", tip: "0".repeat(40) }],
    key_rotate: [{}],
    store_relayout: [{}],
    workspace_init: [{}],
  };
  return Object.entries(calls).flatMap(([name, argumentSets]) => argumentSets.map((args): Call => [name, args]));
}

/** Every file under `dir`, a gzip unpacked, so what a tool wrote there is read as it was shown. */
async function filesUnder(dir: string): Promise<Answer[]> {
  const found: Answer[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      const bytes = await readFile(path);
      found.push({ request: `file ${path}`, text: (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString() });
    }
  }
  return found;
}

/** A client connected in memory to a server over `context`; every elicitation it is shown is
 * answered, declined, so a tool's menu is a response like any other. */
async function connect(
  context: OperationContext,
  answers: Answer[],
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createMcpServer(MUSAI_MCP, context, { lab: true });
  const client = new Client({ name: CLIENT, version: "1.0.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    answers.push({ request: "elicitation/create", text: JSON.stringify(request.params) });
    return { action: "decline" };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Where a request carries a clearance: in its `_meta`, or among its arguments. */
interface Carried {
  readonly meta?: Record<string, unknown>;
  readonly argument?: Record<string, unknown>;
}

/** What `asked` answered, or the message of the error it raised, as text. */
async function answered(asked: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await asked());
  } catch (error) {
    return (error as Error).message;
  }
}

/** The context a server launched over `world`'s workspace is given, with `--clearance` or none. */
function launched(world: World, clearance?: Audience): OperationContext {
  const { workspace, scope } = world.author;
  return { workspace, scope, now, ...(clearance === undefined ? {} : { clearance }) };
}

/** Pushes what `asked` answered, labelled `request`. */
async function answer(answers: Answer[], request: string, asked: () => Promise<unknown>): Promise<void> {
  answers.push({ request, text: await answered(asked) });
}

/** Lists every tool, resource and prompt a server over `context` offers, and calls, reads and gets
 * each one; answers every response, refusals included, and the tools it listed but never called. */
async function sweep(
  context: OperationContext,
  names: Names,
  key: TestKey,
): Promise<{ answers: Answer[]; uncalled: string[] }> {
  const answers: Answer[] = [];
  const { client, close } = await connect(context, answers);
  try {
    const { tools } = await client.listTools();
    answers.push({ request: "tools/list", text: JSON.stringify(tools) });
    const calls = toolCalls(names, key);
    for (const [name, args] of calls) {
      await answer(answers, `tools/call ${name} ${JSON.stringify(args)}`, () =>
        client.callTool({ name, arguments: args }),
      );
    }
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    answers.push({ request: "resources/list", text: JSON.stringify([resources, resourceTemplates]) });
    const uris = [
      ...resources.map((resource) => resource.uri),
      ...[...names.cases, ...names.sealed].map((slug) => `case://${slug}`),
      ...[...names.slots, ...names.sealed, names.derived].map((slot) => `claim://${slot}`),
    ];
    for (const uri of uris) {
      await answer(answers, `resources/read ${uri}`, () => client.readResource({ uri }));
    }
    const { prompts } = await client.listPrompts();
    answers.push({ request: "prompts/list", text: JSON.stringify(prompts) });
    for (const prompt of prompts) {
      for (const value of [...names.sealed, ...names.slots]) {
        const args = Object.fromEntries((prompt.arguments ?? []).map((argument) => [argument.name, value]));
        await answer(answers, `prompts/get ${prompt.name} ${JSON.stringify(args)}`, () =>
          client.getPrompt({ name: prompt.name, arguments: args }),
        );
      }
    }
    answers.push(...(await filesUnder(names.files)));
    const called = new Set(calls.map(([name]) => name));
    return { answers, uncalled: tools.map((tool) => tool.name).filter((name) => !called.has(name)) };
  } finally {
    await close();
  }
}

/** What the request labelled `request` was answered, or `never asked`. */
function answerTo(answers: readonly Answer[], request: string): string {
  return answers.find((answer) => answer.request === request)?.text ?? "never asked";
}

function carrying(answers: readonly Answer[], text: string): string[] {
  return answers.filter((answer) => answer.text.includes(text)).map((answer) => answer.request);
}

/** The responses that name a record the clearance withholds and speak of a seal in one breath. */
function namingASeal(answers: readonly Answer[], names: Names): string[] {
  const withheld = [...names.sealed, names.derived, ...names.unnamed];
  return answers
    .filter((answer) => /seal/i.test(answer.text) && withheld.some((id) => answer.text.includes(id)))
    .map((answer) => answer.request);
}

describe.skipIf(!opensshAvailable)("an MCP server launched under a clearance", () => {
  let key: TestKey;
  const scratch: string[] = [];

  beforeAll(async () => {
    key = await generateTestKey(PUBLISHER);
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    for (const dir of scratch) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows a client no byte of a sealed record through any tool, resource or prompt it lists", async () => {
    const station = await sealedWorld(key, scratch);
    const author = await sealedWorld(key, scratch);

    const seen = await sweep(launched(station.world, WRITER), station.names, key);
    const unsealed = await sweep(launched(author.world), author.names, key);

    expect(carrying(seen.answers, CANARY)).toEqual([]);
    expect(carrying(seen.answers, SEALED_MODULE_PROJECTION)).toEqual([]);
    expect(namingASeal(seen.answers, station.names)).toEqual([]);
    for (const id of station.names.unnamed) {
      expect(carrying(seen.answers, id)).toEqual([]);
    }
    expect(seen.uncalled).toEqual([]);
    const restsOn = station.names.restsOn;
    expect(answerTo(seen.answers, "resources/read case://rests")).toContain("- rests-on — open");
    expect(answerTo(seen.answers, `tools/call brief_render ${JSON.stringify({ claim: restsOn })}`)).toMatch(
      /^\{"content".*rests-on/,
    );
    for (const tool of ["claim_why", "brief_render", "gate_ask"]) {
      for (const id of station.names.sealed) {
        const asked = seen.answers.filter((answer) => answer.request.startsWith(`tools/call ${tool} {"claim":"${id}"`));
        expect(
          asked.map((answer) => answer.text.includes("no-such-record")),
          `${tool} ${id}`,
        ).toEqual([true]);
      }
    }
    expect(carrying(unsealed.answers, CANARY)).not.toEqual([]);
    expect(carrying(unsealed.answers, author.names.unnamed[0]!)).not.toEqual([]);
    expect(carrying(unsealed.answers, SEALED_MODULE_PROJECTION)).toEqual(["tools/list", "prompts/list"]);
  }, 600_000);

  test("answers a request under the clearance it was launched with, whatever clearance the request carries", async () => {
    const { world, names } = await sealedWorld(key, scratch);
    const [hidden] = names.sealed;
    const answers: Answer[] = [];
    const { client, close } = await connect(launched(world, WRITER), answers);
    try {
      const requests: ReadonlyArray<(carried: Carried) => Promise<unknown>> = [
        ...[
          ["claim_why", { claim: names.slots[1], full: true }],
          ["claim_status", { claim: names.slots[1], plan: true }],
          ["view_run", {}],
          ["gate_answer", { pending: hidden, brief: hidden }],
          ["gate_answer", { pending: names.restsOn, brief: names.restsOn }],
        ].map(
          ([name, args]) =>
            ({ meta, argument }: Carried) =>
              client.callTool({ name: name as string, arguments: { ...(args as object), ...argument }, _meta: meta }),
        ),
        ...["case://hides", `claim://${names.slots[1]}`].map(
          (uri) =>
            ({ meta }: Carried) =>
              client.readResource({ uri, _meta: meta }),
        ),
        ({ meta }: Carried) => client.getPrompt({ name: "greeter_note", arguments: { who: hidden! }, _meta: meta }),
      ];
      for (const [index, request] of requests.entries()) {
        const plain = await answered(() => request({}));
        for (const clearance of [null, "public"]) {
          const meta = await answered(() => request({ meta: { clearance } }));
          const argument = await answered(() => request({ argument: { clearance } }));
          answers.push(...[plain, meta, argument].map((text) => ({ request: `request ${index}`, text })));

          expect(meta, `request ${index} under _meta ${clearance}`).toBe(plain);
          if (argument !== plain) {
            expect(JSON.parse(argument), `request ${index} under argument ${clearance}`).toMatchObject({
              isError: true,
              content: [{ text: expect.stringContaining('"reason":"invalid-input"') }],
            });
          }
        }
      }
    } finally {
      await close();
    }
    expect(carrying(answers, CANARY)).toEqual([]);
  }, 300_000);

  test.each([
    ["--clearance <audience>", ["--clearance", WRITER]],
    ["--clearance=<audience>", [`--clearance=${WRITER}`]],
  ])(
    "a server launched with %s answers as the cleared workspace does",
    async (_, flag) => {
      const { world, names } = await sealedWorld(key, scratch);
      const asked = async (client: Client) => [
        JSON.stringify(await client.callTool({ name: "claim_why", arguments: { claim: names.slots[1], full: true } })),
        JSON.stringify(await client.readResource({ uri: "case://rests" }).catch((error: Error) => error.message)),
      ];
      const inProcess = await connect(launched(world, WRITER), []);
      const expected = await asked(inProcess.client).finally(() => inProcess.close());
      const transport = new StdioClientTransport({
        command: "node",
        args: [SERVER_PATH, "--workspace", world.workspace, "--scope", SCOPE, "--lab", ...flag],
        env: { ...getDefaultEnvironment(), MUSAI_NOW: now() },
        stderr: "pipe",
      });
      const client = new Client({ name: CLIENT, version: "1.0.0" });
      await client.connect(transport);

      const seen = await asked(client).finally(() => client.close());

      expect(seen).toEqual(expected);
      expect(seen.join("\n")).not.toContain(CANARY);
    },
    300_000,
  );

  test.each([
    ["one its workspace does not declare", ["--clearance", "readers"], "readers"],
    ["one its workspace does not declare, after an equals sign", ["--clearance=readers"], "readers"],
    ["one that is no audience", ["--clearance", "Not An Audience"], "Not An Audience"],
    ["one that is no audience, after an equals sign", ["--clearance=Not An Audience"], "Not An Audience"],
    ["none at all", ["--clearance"], "--clearance"],
    ["none at all, after an equals sign", ["--clearance="], "--clearance"],
    ["two of them", ["--clearance", WRITER, `--clearance=${WRITER}`], "--clearance"],
  ])(
    "a server launched under a clearance naming %s exits 2 before serving, saying why",
    async (_, flag, named) => {
      const world = await emptyWorld(key, scratch);

      const result = await execa("node", [SERVER_PATH, "--workspace", world.workspace, "--scope", SCOPE, ...flag], {
        stdin: "ignore",
        stderr: "pipe",
        reject: false,
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain(named);
    },
    120_000,
  );

  test("a seal taking the commit a session's cursor names out of its fold leaves its next list and call answering", async () => {
    const world = await emptyWorld(key, scratch);
    const [visible] = await world.store.putMany([{ kind: "claim", value: claim("visible-then-sealed", {}) }]);
    const station = await connect(launched(world, WRITER), []);
    const announced: string[] = [];
    station.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      announced.push("tools/list_changed");
    });
    try {
      await station.client.listTools();
      const before = announced.length;
      await seal(world, visible!);

      const listed = await answered(() => station.client.listTools());
      const called = await answered(() => station.client.callTool({ name: "events_since", arguments: {} }));

      expect(JSON.parse(listed)).toMatchObject({ tools: expect.arrayContaining([expect.anything()]) });
      expect(JSON.parse(called)).toMatchObject({ structuredContent: { events: expect.any(Array) } });
      expect(called).not.toContain(visible);
      expect(announced.slice(before)).toEqual(["tools/list_changed"]);
    } finally {
      await station.close();
    }
  }, 300_000);

  test("a cleared server lists no tool working in what the author keeps, and refuses one called by name", async () => {
    const { world, names } = await sealedWorld(key, scratch);
    const station = await connect(launched(world, WRITER), []);
    try {
      const listed = (await station.client.listTools()).tools.map((tool) => tool.name);

      expect(listed.filter((name) => name in AUTHORS_TOOLS)).toEqual([]);
      for (const [name, args] of Object.entries(AUTHORS_TOOLS)) {
        const refused = await answered(() => station.client.callTool({ name, arguments: args }));
        expect(JSON.parse(refused)).toMatchObject({ isError: true });
        expect(refused).toContain('\\"reason\\":\\"invalid-input\\"');
        expect(refused).toContain(WRITER);
        for (const withheld of [CANARY, ...names.sealed, ...names.cases]) {
          expect(refused).not.toContain(withheld);
        }
      }
    } finally {
      await station.close();
    }
  }, 300_000);

  test.each([
    ["a flag it does not read", ["--clearence", WRITER], "--clearence"],
    ["a flag it reads, spelt with an equals sign", [`--scope=${SCOPE}`], `--scope=${SCOPE}`],
    ["a stray argument", ["writer"], "writer"],
  ])(
    "a server launched with %s exits 2 before serving, naming it",
    async (_, flag, named) => {
      const world = await emptyWorld(key, scratch);

      const result = await execa("node", [SERVER_PATH, "--workspace", world.workspace, ...flag], {
        stdin: "ignore",
        stderr: "pipe",
        reject: false,
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain(named);
    },
    120_000,
  );

  test("a server launched with MUSAI_CLEARANCE set and no --clearance exits 2 before serving, and one given both serves", async () => {
    const world = await emptyWorld(key, scratch);
    const launch = (flag: readonly string[]) =>
      execa("node", [SERVER_PATH, "--workspace", world.workspace, "--scope", SCOPE, ...flag], {
        env: { MUSAI_CLEARANCE: WRITER },
        stdin: "ignore",
        stderr: "pipe",
        reject: false,
        timeout: 60_000,
      });

    const refused = await launch([]);
    const served = await launch(["--clearance", WRITER]);

    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.trim().split("\n")).toHaveLength(1);
    expect(refused.stderr).toContain("MUSAI_CLEARANCE");
    expect(served.exitCode).toBe(0);
    expect(served.stderr).not.toContain("MUSAI_CLEARANCE");
  }, 120_000);

  test("a cleared server lists no tool that reads a file by path, and refuses one called by name", async () => {
    const { world, names } = await sealedWorld(key, scratch);
    const fold = join(world.workspace, MUSAI_DIR, "local", "scopes", SCOPE, "index.sqlite");
    const station = await connect(launched(world, WRITER), []);
    const author = await connect(launched(world), []);
    try {
      const listed = (await station.client.listTools()).tools;
      const authors = (await author.client.listTools()).tools.map((tool) => tool.name);

      expect(listed.map((tool) => tool.name).filter((name) => PATH_TOOLS.includes(name))).toEqual([]);
      expect(
        listed.filter((tool) => PATH_FIELDS.some((field) => field in (tool.inputSchema.properties ?? {}))),
      ).toEqual([]);
      expect(PATH_TOOLS.filter((name) => !authors.includes(name))).toEqual([]);
      const refused = await answered(() =>
        station.client.callTool({ name: "render_markdown", arguments: { file: fold } }),
      );
      expect(JSON.parse(refused)).toMatchObject({ isError: true });
      expect(refused).toContain('\\"reason\\":\\"invalid-input\\"');
      expect(refused).toContain(WRITER);
      for (const withheld of [CANARY, ...names.sealed, "seal"]) {
        expect(refused).not.toContain(withheld);
      }
      const read = await answered(() => author.client.callTool({ name: "render_markdown", arguments: { file: fold } }));
      expect(read).toContain(CANARY);
    } finally {
      await station.close();
      await author.close();
    }
  }, 300_000);

  test("lists and judges a case's visible claims where it cites one sealed from the station", async () => {
    const { world, names } = await sealedWorld(key, scratch);
    const answers: Answer[] = [];
    const { client, close } = await connect(launched(world, WRITER), answers);
    try {
      const calls: Call[] = [
        ["view_run", {}],
        ["gate_pending", {}],
        ["case_status", { case: "hides" }],
        ["case_soundcheck", { case: "hides" }],
      ];
      for (const [name, args] of calls) {
        await answer(answers, name, () => client.callTool({ name, arguments: args }));
      }
      for (const uri of ["gates://pending", "case://hides"]) {
        await answer(answers, uri, () => client.readResource({ uri }));
      }
    } finally {
      await close();
    }

    expect(answers.filter((answer) => !answer.text.startsWith("{") || answer.text.includes('"isError":true'))).toEqual(
      [],
    );
    for (const withheld of [CANARY, ...names.sealed, ...names.unnamed]) {
      expect(carrying(answers, withheld)).toEqual([]);
    }
    expect(carrying(answers, "rests-on")).not.toEqual([]);
  }, 300_000);
});
