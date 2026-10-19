import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, type Scenario, type ScenarioRun } from "@musai/test-support";
import { beforeAll, describe, expect, test } from "vitest";

const SCENARIO_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIO = JSON.parse(await readFile(join(SCENARIO_DIR, "scenario.json"), "utf8")) as Scenario;
const CANARY = "canary-9d41b7";
const CHALLENGE_CANARY = "canary-3e5c20";

/** Named apart from their clearance, so a station step that lost it is still held to the proof. */
const STATION = SCENARIO.steps.map((step) => step.id).filter((id) => id.startsWith("station-"));
const FIRST_PASS = STATION.filter((id) => id.endsWith("-1"));
const SECOND_PASS = STATION.filter((id) => id.endsWith("-2"));

interface Checked {
  readonly claim: string;
  readonly slot: string;
}

interface Minted {
  readonly minted: readonly { readonly id: string }[];
}

interface Briefed {
  readonly brief: string;
  readonly output: string;
}

interface Explained {
  readonly runs: readonly { readonly id: string }[];
}

interface Logged {
  readonly events: readonly { readonly kind: string; readonly about: string; readonly at: string }[];
}

describe("sealing: a station cleared to public reads the workspace before and after its author restates a record sealed from public", () => {
  let run: ScenarioRun;
  const parsed = <T>(id: string): T => JSON.parse(run.raw.get(id)!) as T;
  const bothStreams = (id: string): string => {
    const { stdout, stderr } = run.printed.get(id)!;
    return `${stdout}\n${stderr}`;
  };

  beforeAll(async () => {
    run = await runScenario(SCENARIO_DIR);
  }, 360_000);

  test("every byte each station step printed before the restatement it printed again after it, on both streams", () => {
    expect(FIRST_PASS.length).toBeGreaterThan(0);
    expect(SECOND_PASS.map((id) => id.replace(/-2$/, ""))).toEqual(FIRST_PASS.map((id) => id.replace(/-1$/, "")));
    for (const id of FIRST_PASS) {
      const twin = id.replace(/-1$/, "-2");
      expect(run.printed.get(twin), twin).toEqual(run.printed.get(id));
    }
  });

  test("no station step prints a sealed record's words, or says a record is sealed", () => {
    for (const id of STATION) {
      expect(bothStreams(id), id).not.toContain(CANARY);
      expect(bothStreams(id), id).not.toContain(CHALLENGE_CANARY);
      expect(bothStreams(id), id).not.toMatch(/seal/i);
    }
  });

  test("a brief quoting a sealed challenge is withheld with it: the author reads it, no station step names it", () => {
    const authors = parsed<Briefed>("author-brief");
    expect(authors.output).toContain(CHALLENGE_CANARY);
    for (const id of STATION) {
      expect(bothStreams(id), id).not.toContain(authors.brief);
    }
  });

  test("the author reads the sealed record before the restatement and its successor after it", () => {
    const sealed = parsed<Checked>("hidden").claim;
    const restated = parsed<Checked>("restate").claim;
    expect(parsed<Checked>("restate").slot).toBe(parsed<Checked>("hidden").slot);
    expect(restated).not.toBe(sealed);
    expect(run.raw.get("author-why-1")).toContain(CANARY);
    expect(run.raw.get("author-why-1")).toContain(sealed);
    expect(run.raw.get("author-why-2")).toContain(CANARY);
    expect(run.raw.get("author-why-2")).toContain(restated);
    expect(run.raw.get("author-why-2")).not.toContain(sealed);
  });

  test("the author's log alone names the sealed claim and the run that read it, the sealed challenge's attestations and the brief quoting it, and the restatement and the run that read it, each in a commit the station's log never names save the run that read the sealed claim, landing with the receipt its check performed", () => {
    const station = parsed<Logged>("station-log-2").events;
    const named = new Set(station.map((event) => event.about));
    const authorsOnly = parsed<Logged>("author-log").events.filter((event) => !named.has(event.about));
    expect(authorsOnly.map((event) => [event.kind, event.about])).toEqual([
      ["claim.put", parsed<Checked>("hidden").claim],
      ["run.recorded", expect.any(String)],
      ["attestation.made", parsed<Minted>("seal").minted[0]!.id],
      ["attestation.made", parsed<Minted>("challenge").minted[1]!.id],
      ["attestation.made", parsed<Minted>("seal-challenge").minted[0]!.id],
      ["run.recorded", parsed<Briefed>("author-brief").brief],
      ["claim.put", parsed<Checked>("restate").claim],
      ["run.recorded", expect.any(String)],
    ]);
    const commits = new Set(station.map((event) => event.at));
    const evaluation = authorsOnly[1]!;
    expect(authorsOnly.filter((event) => commits.has(event.at))).toEqual([evaluation]);
    const receipt = parsed<Explained>("author-why-1").runs[0]!.id;
    expect(station.find((event) => event.about === receipt)?.at).toBe(evaluation.at);
  });
});
