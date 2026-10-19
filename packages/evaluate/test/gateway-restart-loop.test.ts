import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import { InProcessHost, invokerFromModuleHost, kernelPoint, type ModuleHost, SubprocessHost } from "@musai/modules";
import { versionString } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, gatewaySource, makeFixtureRepo } from "@musai/test-support";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runRestartLoop } from "../src/evaluator/restart.js";

const REQUESTS_A_RUN_BODY = [
  "      if (input.evidence.length === 0) {",
  "        return {",
  '          kind: "request",',
  "          needs: [",
  "            {",
  '              kind: "run",',
  "              recipe: {",
  '                command: ["printf", "%s", "ok"],',
  '                workingDirectory: "/",',
  "                environment: {},",
  "                declared: [],",
  "                substrates: [],",
  '                isolation: "hygiene",',
  "              },",
  "            },",
  "          ],",
  "        };",
  "      }",
  "      const receipt = input.evidence[0];",
  "      return receipt.exitCode === 0",
  '        ? { kind: "verdict", label: "holds", reason: "the run through the gateway exited cleanly" }',
  '        : { kind: "verdict", label: "fails", reason: "the run through the gateway exited with a fault" };',
].join("\n");

const CONTRIBUTION = {
  id: "fixture-gateway-restart-loop/decides",
  version: versionString("1"),
  entry: {
    kind: "rule" as const,
    id: "fixture-gateway-restart-loop/decides",
    version: versionString("1"),
    input: true,
    output: true,
    documentation: "",
  },
  point: kernelPoint("rule")!,
};

describe("the restart loop driven through a host: the envelope crosses on every round, never a bare call", () => {
  let scratchDir: string;
  let modulePath: string;
  const repos: FixtureRepo[] = [];

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-gateway-restart-loop-"));
    modulePath = join(scratchDir, "requests-a-run.rule.ts");
    await writeFile(modulePath, gatewaySource("invoke", REQUESTS_A_RUN_BODY));
  });

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  const hosts: readonly { readonly name: string; readonly create: () => ModuleHost }[] = [
    { name: "in-process", create: () => new InProcessHost() },
    { name: "subprocess", create: () => new SubprocessHost() },
  ];

  for (const { name, create } of hosts) {
    test(`${name}: a gateway invoked only through the envelope resolves its requested run and concludes`, async () => {
      const repo = await freshRepo(`gateway-restart-loop-${name}`);
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
      const host = create();
      const loaded = await host.load(modulePath, "invoke");
      const invoker = invokerFromModuleHost(host, loaded, CONTRIBUTION);

      const result = await runRestartLoop({
        invoker,
        input: { claimId: `claim-gateway-${name}`, conditions: {}, evidence: [] },
        store,
        index: new IndexDb(),
        now: repo.now,
      });

      expect(result.invocations).toBe(2);
      expect(result.receipts).toHaveLength(1);
      expect(result.verdict).toEqual({
        kind: "verdict",
        label: "holds",
        reason: "the run through the gateway exited cleanly",
      });

      const receipt = await store.read(result.receipts[0]!.id, "run");
      expect(receipt).toMatchObject({ observation: { exitCode: 0, output: "ok" } });
    });
  }
});
