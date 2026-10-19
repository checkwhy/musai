import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Argument,
  compareArguments,
  type EvidenceHop,
  type EvidenceKind,
  type Ordering,
  weakestLink,
} from "@musai/evaluate";
import { exactDecimal, type Scope } from "@musai/records";
import { expect } from "vitest";

interface OrderingFixtureArgument {
  readonly id: string;
  readonly evidenceChain: readonly EvidenceHop[];
  readonly scope: Scope;
  readonly weight: string;
}

interface OrderingFixture {
  readonly kind: "ordering";
  readonly source: string;
  readonly description: string;
  readonly arguments: readonly [OrderingFixtureArgument, OrderingFixtureArgument];
  readonly expected: {
    readonly winner: string;
    readonly decidedBy: Ordering["decidedBy"];
  };
}

interface WeakestLinkFixture {
  readonly kind: "weakest-link";
  readonly source: string;
  readonly description: string;
  readonly chain: readonly EvidenceHop[];
  readonly expected: {
    readonly cappedKind: EvidenceKind;
    readonly cappedHopIndex: number;
  };
}

type Fixture = OrderingFixture | WeakestLinkFixture;

function toArgument(raw: OrderingFixtureArgument): Argument {
  return {
    id: raw.id,
    evidenceKind: weakestLink(raw.evidenceChain).kind,
    scope: raw.scope,
    declaredWeight: exactDecimal(raw.weight),
  };
}

function runOrderingFixture(file: string, fixture: OrderingFixture): void {
  if (fixture.expected.decidedBy === undefined || fixture.expected.winner === undefined) {
    throw new Error(`fixture ${file} (${fixture.source}) declares no justification alongside its label`);
  }
  const [rawFirst, rawSecond] = fixture.arguments;
  const first = toArgument(rawFirst);
  const second = toArgument(rawSecond);
  const comparison = compareArguments(first, second);
  const winnerId = comparison.winner === "a" ? first.id : comparison.winner === "b" ? second.id : "open";

  const context = `fixture ${file} (${fixture.source}): ${fixture.description}`;
  expect(winnerId, `${context} — winner`).toBe(fixture.expected.winner);
  expect(comparison.decidedBy, `${context} — justification`).toBe(fixture.expected.decidedBy);
}

function runWeakestLinkFixture(file: string, fixture: WeakestLinkFixture): void {
  if (fixture.expected.cappedKind === undefined || fixture.expected.cappedHopIndex === undefined) {
    throw new Error(`fixture ${file} (${fixture.source}) declares no justification alongside its label`);
  }
  const link = weakestLink(fixture.chain);
  const cappedHopIndex = fixture.chain.findIndex((hop) => hop.id === link.settledBy.id);

  const context = `fixture ${file} (${fixture.source}): ${fixture.description}`;
  expect(link.kind, `${context} — capped kind`).toBe(fixture.expected.cappedKind);
  expect(cappedHopIndex, `${context} — hop that set the ceiling`).toBe(fixture.expected.cappedHopIndex);
}

/** Asserts each fixture's justification beside its label, since a status reached by the wrong
 * derivation is cheapest to catch here. */
export async function runFixtureTable(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const fixtureFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  expect(fixtureFiles.length, `no fixtures found under ${dir}`).toBeGreaterThan(0);

  for (const file of fixtureFiles) {
    const raw = await readFile(join(dir, file), "utf8");
    const fixture = JSON.parse(raw) as Fixture;
    if (fixture.kind === "ordering") {
      runOrderingFixture(file, fixture);
    } else {
      runWeakestLinkFixture(file, fixture);
    }
  }
}
