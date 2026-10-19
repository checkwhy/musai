import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { type Checkout, makeCheckout } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

const RUNS = 5;

/** About twice the median a loaded four-core container measured, so a slower runner passes and a
 * doubling fails. */
const CHECK_CEILING_MS = 3_000;
const STATUS_CEILING_MS = 2_000;

let checkout: Checkout;
let claim: string;

async function musai(args: readonly string[]): Promise<{ stdout: string; ms: number }> {
  const started = performance.now();
  const { stdout } = await execa("node", [CLI_PATH, "--workspace", checkout.dir, ...args], {
    env: { ...process.env, MUSAI_PRINCIPAL: "latency-test" },
  });
  return { stdout, ms: performance.now() - started };
}

async function medianOf(run: (index: number) => Promise<{ ms: number }>): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    times.push((await run(index)).ms);
  }
  return times.sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;
}

beforeAll(async () => {
  checkout = await makeCheckout();
  await musai(["init"]);
  claim = (JSON.parse((await musai(["check", "--json", "true holds", "--", "true"])).stdout) as { claim: string })
    .claim;
}, 60_000);

afterAll(async () => {
  await checkout.cleanup();
});

test("a check on a small workspace answers within its latency bound", async () => {
  const median = await medianOf((index) => musai(["check", "--json", `true holds ${index}`, "--", "true"]));
  console.info(`check, median of ${RUNS}: ${Math.round(median)} ms`);
  expect(median).toBeLessThan(CHECK_CEILING_MS);
}, 120_000);

test("a status on a small workspace answers within its latency bound", async () => {
  const median = await medianOf(() => musai(["status", "--json", claim]));
  console.info(`status, median of ${RUNS}: ${Math.round(median)} ms`);
  expect(median).toBeLessThan(STATUS_CEILING_MS);
}, 120_000);
