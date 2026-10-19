import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import { InProcessHost, invokerFromModuleHost, kernelPoint, type ModuleHost, SubprocessHost } from "@musai/modules";
import { recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, gatewaySource, makeFixtureRepo } from "@musai/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { runRestartLoop } from "../src/evaluator/restart.js";

const REQUESTS_A_BODY_BODY = [
  "      if (input.refusals && input.refusals.length > 0) {",
  "        const refusal = input.refusals[0];",
  '        return { kind: "verdict", label: "open", reason: "refused: " + refusal.error.code + ": " + refusal.error.message };',
  "      }",
  "      if (input.evidence.length === 0) {",
  "        return {",
  '          kind: "request",',
  "          needs: [",
  "            {",
  '              kind: "fetch",',
  "              recipe: { locator: globalThis.__fixtureLocator, headers: [], names: [] },",
  "            },",
  "          ],",
  "        };",
  "      }",
  "      const receipt = input.evidence[0];",
  "      return receipt.exitCode === 200",
  '        ? { kind: "verdict", label: "holds", reason: "the fetch succeeded" }',
  '        : { kind: "verdict", label: "fails", reason: "the fetch did not succeed" };',
].join("\n");

const CONTRIBUTION = {
  id: "fixture-gateway-fetch-need/decides",
  version: versionString("1"),
  entry: {
    kind: "rule" as const,
    id: "fixture-gateway-fetch-need/decides",
    version: versionString("1"),
    input: true,
    output: true,
    documentation: "",
  },
  point: kernelPoint("rule")!,
};

describe("a rule that asks for a body, satisfied through the same restart loop that satisfies a request for a run", () => {
  let server: Server;
  let locator: string;
  let body: string;
  let scratchDir: string;
  let modulePath: string;
  const repos: FixtureRepo[] = [];

  beforeAll(async () => {
    body = "a body a rule cites as its own evidence";
    server = createServer((req, res) => {
      if (req.url === "/redirected") {
        res.writeHead(301, { location: "/citation" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the test server to bind a numeric port");
    }
    locator = `http://127.0.0.1:${address.port}/citation`;

    scratchDir = await mkdtemp(join(tmpdir(), "musai-gateway-fetch-need-"));
    modulePath = join(scratchDir, "requests-a-body.rule.ts");
    await writeFile(
      modulePath,
      gatewaySource("invoke", REQUESTS_A_BODY_BODY, `globalThis.__fixtureLocator = ${JSON.stringify("")};`),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  async function moduleNaming(fixtureLocator: string): Promise<string> {
    const path = join(
      scratchDir,
      `${recordId({ marker: fixtureLocator }).slice("sha256:".length, "sha256:".length + 12)}.rule.ts`,
    );
    await writeFile(
      path,
      gatewaySource("invoke", REQUESTS_A_BODY_BODY, `globalThis.__fixtureLocator = ${JSON.stringify(fixtureLocator)};`),
    );
    return path;
  }

  const hosts: readonly { readonly name: string; readonly create: () => ModuleHost }[] = [
    { name: "in-process", create: () => new InProcessHost() },
    { name: "subprocess", create: () => new SubprocessHost() },
  ];

  for (const { name, create } of hosts) {
    test(`${name}: a fetch need reaches a verdict and mints a receipt of the citation kind, whose recipe cites the resolved digest`, async () => {
      const repo = await freshRepo(`gateway-fetch-need-${name}`);
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
      const host = create();
      const path = await moduleNaming(locator);
      const loaded = await host.load(path, "invoke");
      const invoker = invokerFromModuleHost(host, loaded, CONTRIBUTION);

      try {
        const result = await runRestartLoop({
          invoker,
          input: { claimId: `claim-fetch-${name}`, conditions: {}, evidence: [] },
          store,
          index: new IndexDb(),
          now: repo.now,
        });

        expect(result.invocations).toBe(2);
        expect(result.receipts).toHaveLength(1);
        expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "the fetch succeeded" });

        const receipt = (await store.read(result.receipts[0]!.id, "run")) as {
          runKind: string;
          recipe: { substrates: readonly { uri?: string }[] };
          observation: { resolved: readonly { digest?: { sha256?: string } }[] };
        };
        expect(receipt.runKind).toBe("citation");
        expect(receipt.recipe.substrates[0]?.uri).toBe(locator);
        expect(receipt.observation.resolved[0]?.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await host.close?.();
      }
    });
  }

  test("the same body requested twice within one evaluation mints exactly one receipt", async () => {
    const repo = await freshRepo("gateway-fetch-need-dedup");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const host = new InProcessHost();
    try {
      const path = await moduleNaming(locator);
      const loaded = await host.load(path, "invoke");
      const invoker = invokerFromModuleHost(host, loaded, CONTRIBUTION);
      const index = new IndexDb();
      const evaluationOutcomes = new Map();

      const first = await runRestartLoop({
        invoker,
        input: { claimId: "claim-dedup-a", conditions: {}, evidence: [] },
        store,
        index,
        evaluationOutcomes,
        now: repo.now,
      });
      const second = await runRestartLoop({
        invoker,
        input: { claimId: "claim-dedup-b", conditions: {}, evidence: [] },
        store,
        index,
        evaluationOutcomes,
        now: repo.now,
      });

      expect(first.receipts).toEqual(second.receipts);
      expect(first.receipts).toHaveLength(1);
    } finally {
      await host.close?.();
    }
  });

  test("an unreachable body refuses with a closed envelope error code naming the reason, rather than resolving to an empty body", async () => {
    const repo = await freshRepo("gateway-fetch-need-refused");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const host = new InProcessHost();
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected the test server to bind a numeric port");
      }
      const redirectingLocator = `http://127.0.0.1:${address.port}/redirected`;
      const path = await moduleNaming(redirectingLocator);
      const loaded = await host.load(path, "invoke");
      const invoker = invokerFromModuleHost(host, loaded, CONTRIBUTION);

      const result = await runRestartLoop({
        invoker,
        input: { claimId: "claim-refused", conditions: {}, evidence: [] },
        store,
        index: new IndexDb(),
        now: repo.now,
      });

      expect(result.verdict.label).toBe("open");
      expect(result.verdict.reason).toMatch(/redirect/);
      expect(result.receipts).toHaveLength(0);
    } finally {
      await host.close?.();
    }
  });
});
