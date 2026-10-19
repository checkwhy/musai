import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  applyEdit,
  commitStep,
  deleteFolds,
  firstDifference,
  normalise,
  resolvePlaceholders,
  runScenario,
  runScenarioInto,
  SCENARIO_INSTANT,
  scenarioPath,
  scenarioWorkspace,
  stepEnvironment,
  stepInstant,
  withPlaceholderIds,
} from "@musai/test-support";
import { describe, expect, test, vi } from "vitest";

const context = { repo: "/r", scenarioDir: "/r/packages/scenarios/x", workspace: "/tmp/w" };

describe("scenario normalisation", () => {
  test("replaces the paths, commit shas and instants, and nothing else", () => {
    const sha = "a".repeat(40);
    const id = `sha256:${"b".repeat(64)}`;
    const text = `{"at":"${sha}","id":"${id}","when":"2026-01-01T00:00:00.000Z","where":"/tmp/w/.musai"}`;
    expect(normalise(text, context)).toBe(
      `{"at":"<commit>","id":"${id}","when":"<time>","where":"<workspace>/.musai"}`,
    );
  });

  test("a word spelled as the user running the suite is left as it is, since every step pins its principal", () => {
    const text = `{"performer":{"kind":"${userInfo().username}"}}`;
    expect(normalise(text, context)).toBe(text);
  });

  test("an instant git spells with a numeric offset is an instant too", () => {
    const text = '{"recency":"2026-01-01T00:00:00+00:00","later":"2026-01-01T02:00:00-01:30"}';
    expect(normalise(text, context)).toBe('{"recency":"<time>","later":"<time>"}');
  });

  test("a record id is never mistaken for a commit sha", () => {
    const id = `sha256:${"c".repeat(64)}`;
    expect(normalise(id, context)).toBe(id);
  });

  test("a pseudonym's key id, minted at random with the workspace key, is a placeholder, and its hash is left to the ids", () => {
    const hash = "d".repeat(64);
    const text = `{"principal":"pseudonym:8d0f4c62-5a1e-4b7a-9c3d-2e6f1a0b9c71:${hash}"}`;
    expect(normalise(text, context)).toBe(`{"principal":"pseudonym:<key>:${hash}"}`);
  });
});

describe("comparing a scenario's outputs with its recording", () => {
  const thisMachinesIds = { first: "3d".repeat(32), second: "4c".repeat(32) };
  const anotherMachinesIds = { first: "1f".repeat(32), second: "2e".repeat(32) };

  function steps(entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, string> {
    return new Map(entries);
  }

  test("an output holds against a recording of placeholders whichever ids the machine derived", () => {
    const outputs = (ids: typeof thisMachinesIds) =>
      steps([
        ["mint", `{"minted":["sha256:${ids.first}","sha256:${ids.second}"]}`],
        ["why", `{"claim":"sha256:${ids.second}","cites":["sha256:${ids.first}"]}`],
      ]);
    const recorded = steps([
      ["mint", '{"minted":["sha256:<id-1>","sha256:<id-2>"]}'],
      ["why", '{"claim":"sha256:<id-2>","cites":["sha256:<id-1>"]}'],
    ]);

    expect(firstDifference(outputs(thisMachinesIds), recorded)).toBeUndefined();
    expect(firstDifference(outputs(anotherMachinesIds), recorded)).toBeUndefined();
  });

  test("an output differing from its recording in one character outside an id fails", () => {
    const recorded = steps([["status", '{"id":"sha256:<id-1>","state":"holds"}']]);
    const actual = steps([["status", `{"id":"sha256:${thisMachinesIds.first}","state":"holdz"}`]]);

    expect(firstDifference(actual, recorded)?.id).toBe("status");
  });

  test("a recording that holds a derived id fails, since a recording holds placeholders only", () => {
    const text = `{"id":"sha256:${thisMachinesIds.first}"}`;

    expect(firstDifference(steps([["mint", text]]), steps([["mint", text]]))?.id).toBe("mint");
  });

  test("two recorded ids collapsing into one id in the run fail", () => {
    const recorded = steps([["mint", "sha256:<id-1> sha256:<id-2>"]]);
    const actual = steps([["mint", `sha256:${thisMachinesIds.first} sha256:${thisMachinesIds.first}`]]);

    expect(firstDifference(actual, recorded)?.id).toBe("mint");
  });

  test("two ids swapped between two steps fail, since first appearance fixes each placeholder", () => {
    const recorded = steps([
      ["mint", "sha256:<id-1> sha256:<id-2>"],
      ["list", "sha256:<id-1> sha256:<id-2>"],
    ]);
    const actual = steps([
      ["mint", `sha256:${thisMachinesIds.first} sha256:${thisMachinesIds.second}`],
      ["list", `sha256:${thisMachinesIds.second} sha256:${thisMachinesIds.first}`],
    ]);

    expect(firstDifference(actual, recorded)?.id).toBe("list");
  });

  test("an anchor label that prefixes an id is recorded with that id's placeholder", () => {
    const outputs = (labelled: string) =>
      steps([
        ["mint", `sha256:${thisMachinesIds.first} sha256:${thisMachinesIds.second}`],
        ["render", `{"path":"artifacts/${labelled.slice(0, 12)}.md"}`],
      ]);
    const recorded = steps([
      ["mint", "sha256:<id-1> sha256:<id-2>"],
      ["render", '{"path":"artifacts/<id-1:12>.md"}'],
    ]);

    expect(firstDifference(outputs(thisMachinesIds.first), recorded)).toBeUndefined();
    expect(firstDifference(outputs(thisMachinesIds.second), recorded)?.id).toBe("render");
  });

  test("a hex word shorter than any label is recorded as itself, whatever id it happens to begin", () => {
    const recorded = steps([["mint", "sha256:<id-1> a 1"]]);
    const actual = steps([["mint", `sha256:${"b".repeat(64)} a 1`]]);

    expect(firstDifference(actual, recorded)).toBeUndefined();
  });

  test("one id is one placeholder in every step of a scenario, and two ids are two", () => {
    const placeheld = withPlaceholderIds(
      new Map([
        ["mint", `sha256:${thisMachinesIds.first} sha256:${thisMachinesIds.second}`],
        ["list", `sha256:${thisMachinesIds.second}`],
        ["show", `sha256:${thisMachinesIds.first} sha256:${thisMachinesIds.first}`],
      ]),
    );

    expect([...placeheld]).toEqual([
      ["mint", "sha256:<id-1> sha256:<id-2>"],
      ["list", "sha256:<id-2>"],
      ["show", "sha256:<id-1> sha256:<id-1>"],
    ]);
  });
});

describe("placeholders", () => {
  test("reads a field of an earlier step's parsed output by dotted path", () => {
    const parsed = new Map<string, unknown>([["book", { minted: [{ id: "sha256:x", record: { slot: "s1" } }] }]]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder the scenario runner resolves, not a template
    const resolved = resolvePlaceholders(["status", "${book.minted.0.record.slot}", "$WORKSPACE"], {
      ...context,
      cli: "",
      parsed,
    });
    expect(resolved).toEqual(["status", "s1", "/tmp/w"]);
  });
});

describe("the environment the binary runs under", () => {
  test.skipIf(process.platform === "win32")(
    "declares its PATH: the running node, the repository's bin, the system directories, and nothing from the invoking shell",
    () => {
      expect(scenarioPath("/r").split(delimiter)).toEqual([
        dirname(process.execPath),
        "/r/node_modules/.bin",
        "/usr/bin",
        "/bin",
      ]);
    },
  );

  test("a step's clearance reaches it as MUSAI_CLEARANCE, and a clearance the shell holds reaches no step", () => {
    vi.stubEnv("MUSAI_CLEARANCE", "the-shells-own");
    try {
      expect(stepEnvironment({ id: "author" }, "/r")).not.toHaveProperty("MUSAI_CLEARANCE");
      expect(stepEnvironment({ id: "station", clearance: "public" }, "/r")).toMatchObject({
        MUSAI_CLEARANCE: "public",
        MUSAI_NOW: SCENARIO_INSTANT,
        PATH: scenarioPath("/r"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the steps that prepare what the binary reads", () => {
  test("a commit step answers the same commit and tree over two fresh repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-commit-"));
    try {
      await mkdir(join(root, "from"));
      await writeFile(join(root, "from", "README"), "one tree\n");
      await writeFile(join(root, "from", "tool"), "#!/usr/bin/env node\n", { mode: 0o755 });
      const answers = [];
      for (const name of ["first", "second"]) {
        const workspace = join(root, name);
        await mkdir(workspace);
        answers.push(
          await commitStep(
            { repo: "$WORKSPACE/checkout", from: join(root, "from"), message: "one tree" },
            { ...context, workspace, cli: "", parsed: new Map() },
          ),
        );
      }
      expect(answers[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(answers[1]).toEqual(answers[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a json edit resolves $WORKSPACE in a string leaf and writes JSON that parses back when the path holds a backslash", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-edit-"));
    try {
      const workspace = join(root, "back\\slash");
      await mkdir(workspace);
      await applyEdit(
        { path: "$WORKSPACE/checkouts.json", json: { checkout: { directory: "$WORKSPACE/checkout" }, depth: 1 } },
        { ...context, workspace, cli: "", parsed: new Map() },
      );
      expect(JSON.parse(await readFile(join(workspace, "checkouts.json"), "utf8"))).toEqual({
        checkout: { directory: `${workspace}/checkout` },
        depth: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the replay's fold deletion", () => {
  test("removes each scope's fold and every cleared fold beside it, and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-folds-"));
    try {
      const scope = join(root, "scopes", "default");
      await mkdir(join(scope, "cleared"), { recursive: true });
      for (const file of ["index.sqlite", "cleared/0a1b.sqlite", "verification.sqlite"]) {
        await writeFile(join(scope, file), "");
      }
      await deleteFolds(root);
      expect((await readdir(scope)).sort()).toEqual(["cleared", "verification.sqlite"]);
      expect(await readdir(join(scope, "cleared"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a step's own instant", () => {
  test("a step declaring no `now` runs at SCENARIO_INSTANT, and one declaring one runs at it", () => {
    expect(stepInstant({ id: "s" })).toBe(SCENARIO_INSTANT);
    expect(stepInstant({ id: "s", now: "2020-06-15T00:00:00.000Z" })).toBe("2020-06-15T00:00:00.000Z");
  });
});

describe("where a scenario runs", () => {
  test("a workspace path differs between two clones of the repository and between two scenarios, and repeats for the same pair", () => {
    const scenario = "/r/packages/scenarios/first-use";
    const path = scenarioWorkspace("/r", scenario);

    expect(scenarioWorkspace("/r", scenario)).toBe(path);
    expect(scenarioWorkspace("/other", scenario)).not.toBe(path);
    expect(scenarioWorkspace("/r", "/r/packages/scenarios/sealing")).not.toBe(path);
    expect(dirname(path)).toBe(tmpdir());
  });

  test("two clones sharing a directory name get different workspaces for the same scenario", () => {
    const scenario = "packages/scenarios/first-use";

    expect(scenarioWorkspace("/a/musai", `/a/musai/${scenario}`)).not.toBe(
      scenarioWorkspace("/b/musai", `/b/musai/${scenario}`),
    );
  });
});

describe("what the binary printed", () => {
  test("both streams of every CLI step reach the run, and only a step's own clearance reaches the binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-streams-"));
    vi.stubEnv("MUSAI_SCENARIO_RECORD", "1");
    vi.stubEnv("MUSAI_CLEARANCE", "an-undeclared-audience");
    try {
      await writeFile(
        join(root, "scenario.json"),
        JSON.stringify({
          steps: [
            { id: "init", args: ["init", "$WORKSPACE"] },
            { id: "author", args: ["status", "no-such-claim"], exit: 2 },
            { id: "station", args: ["status", "no-such-claim"], exit: 2, clearance: "an-undeclared-audience" },
          ],
          replay: [],
          holds: [],
        }),
      );
      const run = await runScenario(root);
      const refusal = (id: string) => JSON.parse(run.printed.get(id)!.stderr) as { reason: string; about: string[] };

      expect(run.printed.get("init")).toEqual({ stdout: run.raw.get("init"), stderr: "" });
      expect(run.printed.get("author")).toEqual({ stdout: "", stderr: run.raw.get("author") });
      expect(refusal("author").reason).toBe("no-such-record");
      expect(refusal("station")).toMatchObject({ reason: "invalid-input", about: ["an-undeclared-audience"] });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("running a scenario into a directory the caller owns", () => {
  test("leaves the directory in place, with the steps' effects in it", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-into-"));
    try {
      const scenarioDir = join(root, "scenario");
      const workspace = join(root, "workspace");
      await mkdir(scenarioDir);
      await mkdir(workspace);
      await writeFile(
        join(scenarioDir, "scenario.json"),
        JSON.stringify({
          steps: [{ id: "note", edit: { path: "$WORKSPACE/note.txt", append: "hello" } }],
          replay: [],
          holds: [],
        }),
      );
      await runScenarioInto(scenarioDir, workspace);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("hello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
