import type { Distribution, OperationDescriptor } from "@musai/api-core";
import { exitCodeForClass, versionString } from "@musai/records";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../src/index.js";

/** Answers a constant, so running it touches no workspace. */
const GREET: OperationDescriptor = {
  id: "fixture.greet",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "count"],
    properties: {
      greeting: { type: "string" },
      count: { type: "number" },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-input"],
  documentation: "Answers one constant greeting.",
  cli: {
    verb: "greet",
    positional: [],
    flags: [],
    describe: "answer one constant greeting",
  },
  renderText: () => "hello, twice",
  exitCode: () => 0,
  handler: async () => ({ greeting: "hello", count: 2 }),
};

const FAILURE_MESSAGE = "the fixture failed with no reason";

/** Throws a bare `Error`, which carries no reason: a defect, whatever raised it. */
const FAILS: OperationDescriptor = {
  id: "fixture.fails",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: [],
  documentation: "Fails with no reason.",
  cli: {
    verb: "fails",
    positional: [],
    flags: [],
    describe: "fail with no reason",
  },
  renderText: () => "",
  exitCode: () => 0,
  handler: async () => {
    throw new Error(FAILURE_MESSAGE);
  },
};

/** Answers the words it was handed, so a test reads what the command line parsed. */
const ECHO: OperationDescriptor = {
  id: "fixture.echo",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["first"],
    properties: {
      first: { type: "string" },
      words: { type: "array", items: { type: "string" } },
      label: { type: "string", description: "a label beside the words" },
      settings: { type: "object" },
    },
  },
  output: true,
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-input"],
  documentation: "Answers its own input.",
  cli: {
    verb: "echo",
    positional: ["first"],
    rest: "words",
    flags: ["label", "settings"],
    describe: "answer the words handed to it",
  },
  renderText: () => "",
  exitCode: () => 0,
  handler: async (input) => input,
};

/** Hands the trace a write leaves behind to the context it runs under, as a dispatch would. */
const TRACES: OperationDescriptor = {
  id: "fixture.traces",
  version: versionString("1"),
  input: { type: "object", additionalProperties: false, properties: {} },
  output: { type: "object", additionalProperties: false, properties: {} },
  effect: "read",
  authority: null,
  plans: true,
  reasons: [],
  documentation: "Leaves one subscription trace.",
  cli: { verb: "traces", positional: [], flags: [], describe: "leave one subscription trace" },
  renderText: () => "",
  exitCode: () => 0,
  handler: async (_input, context) => {
    await context.reportSubscription!({
      subscription: "pack/on-claim",
      version: "1",
      event: { name: "claim.put", payload: { id: "sha256:a", about: "sha256:a", at: "abc" } },
      error: { code: "need-refused\nforged" as never, data: null, message: "the run named a binary\nnothing declares" },
    });
    return {};
  },
};

/** Answers the name the command runs under, as the surface established it. */
const WHOAMI: OperationDescriptor = {
  ...GREET,
  id: "fixture.whoami",
  output: {
    type: "object",
    additionalProperties: false,
    required: ["principalName"],
    properties: { principalName: { type: ["string", "null"] } },
  },
  documentation: "Answers the name the command runs under.",
  cli: { ...GREET.cli, verb: "whoami", describe: "answer the name the command runs under" },
  renderText: () => "whoami",
  handler: async (_input, context) => ({ principalName: context.principalName ?? null }),
};

const FIXTURE: Distribution = {
  name: "fixture",
  version: "1.2.3",
  registry: new Map([
    [`${GREET.id}@${GREET.version}`, GREET],
    [`${FAILS.id}@${FAILS.version}`, FAILS],
    [`${ECHO.id}@${ECHO.version}`, ECHO],
    [`${TRACES.id}@${TRACES.version}`, TRACES],
    [`${WHOAMI.id}@${WHOAMI.version}`, WHOAMI],
  ]),
  admitDrafts: async () => {
    throw new Error("the command line reaches no pack's operation, so nothing it runs drafts a record to admit");
  },
};

async function writtenTo(stream: NodeJS.WriteStream, argv: readonly string[]): Promise<string> {
  const written: string[] = [];
  const write = vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await runCli(FIXTURE, argv);
  } finally {
    write.mockRestore();
  }
  return written.join("");
}

describe("runCli", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  test("the command line is built from the distribution it is handed and nothing else", async () => {
    const answered = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "greet", "--json"]);

    expect(answered).toBe('{"count":2,"greeting":"hello"}');
    expect(process.exitCode).toBe(0);

    // A nameless program takes argv[1]'s basename, so it must not be the distribution's name.
    const help = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "--help"]);

    expect(help).toMatch(/^Usage: fixture \[options\] \[command\]\n/);
    const commands = [...(help.split("\nCommands:\n")[1] ?? "").matchAll(/^ {2}(\S+)/gm)].map((match) => match[1]);
    expect(commands).toEqual(["greet", "fails", "echo", "traces", "whoami", "help"]);
    expect(help).toContain("answer one constant greeting");
    expect(process.exitCode).toBe(0);
  });

  test("a command runs under the name MUSAI_PRINCIPAL gives, and never under the machine's user name", async () => {
    vi.stubEnv("MUSAI_PRINCIPAL", undefined);
    const unnamed = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "whoami", "--json"]);
    expect(JSON.parse(unnamed)).toEqual({ principalName: null });

    vi.stubEnv("MUSAI_PRINCIPAL", "florin");
    const named = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "whoami", "--json"]);
    expect(JSON.parse(named)).toEqual({ principalName: "florin" });
  });

  test("a rest the input does not require may be left out, an option standing in its place", async () => {
    const bare = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "echo", "x", "--label", "m/r", "--json"]);
    const rest = await writtenTo(process.stdout, ["node", "/nowhere/bin.js", "echo", "x", "--json", "--", "a", "-b"]);

    expect(JSON.parse(bare)).toEqual({ first: "x", label: "m/r" });
    expect(JSON.parse(rest)).toEqual({ first: "x", words: ["a", "-b"] });
  });

  test("an object option is read as one JSON object, and anything else is refused as the caller's to fix", async () => {
    const spelled = await writtenTo(process.stdout, [
      "node",
      "/nowhere/bin.js",
      "echo",
      "x",
      "--settings",
      '{"suite":["npm","test"],"retries":2}',
      "--json",
    ]);
    expect(JSON.parse(spelled)).toEqual({ first: "x", settings: { suite: ["npm", "test"], retries: 2 } });

    for (const bad of ["not json", "[1]", "null", '"text"']) {
      process.exitCode = undefined;
      const printed = await writtenTo(process.stderr, ["node", "/nowhere/bin.js", "echo", "x", "--settings", bad]);
      expect(printed).toContain("--settings");
      expect(process.exitCode).toBe(exitCodeForClass("invocation"));
    }
  });

  test("a subscription's refused answer is printed as one line on standard error, naming the subscription and its event", async () => {
    const printed = await writtenTo(process.stderr, ["node", "/nowhere/bin.js", "traces"]);

    expect(printed).toBe(
      'subscription "pack/on-claim" refused claim.put: "need-refused\\nforged": "the run named a binary\\nnothing declares"\n',
    );
  });

  test("a failure carrying no reason exits with the code that says to report a bug, and prints its message alone", async () => {
    vi.stubEnv("MUSAI_DEBUG", undefined);

    const printed = await writtenTo(process.stderr, ["node", "/nowhere/bin.js", "fails"]);

    expect(process.exitCode).toBe(1);
    expect(printed).toBe(`${FAILURE_MESSAGE}\n`);
  });

  test("a failure carrying no reason prints its stack when it is asked for", async () => {
    vi.stubEnv("MUSAI_DEBUG", "1");

    const printed = await writtenTo(process.stderr, ["node", "/nowhere/bin.js", "fails"]);

    expect(process.exitCode).toBe(1);
    expect(printed).toContain(FAILURE_MESSAGE);
    expect(printed).toContain("    at ");
  });
});
