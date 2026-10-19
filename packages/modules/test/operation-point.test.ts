import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionEntry, RecordKind } from "@musai/records";
import { KIND_CONTRACTS, RECORD_KINDS, versionString } from "@musai/records";
import { gatewaySource } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOSTS } from "../src/module/hosts.js";
import { ENVELOPE_PROTOCOL, type EnvelopeResponse, kernelPoint, type PlannedRecord } from "../src/rule/envelope.js";

/** A pack's operation answering whatever plan its `answer` argument names; its arguments are
 * the ones its own entry declares. */
const ANSWERS_A_PLAN_BODY = [
  "      if (input.answer === 'puts') {",
  "        return { put: input.puts, attest: [], needs: [] };",
  "      }",
  "      if (input.answer === 'fourth-field') {",
  "        return { put: [], attest: [], needs: [], principal: 'someone' };",
  "      }",
  "      return {",
  "        put: [{ kind: 'artifact', value: { echoed: input.subject } }],",
  "        attest: [{ subject: { put: 0 }, purpose: 'made' }],",
  "        needs: [],",
  "      };",
].join("\n");

const ENTRY: ContributionEntry = {
  kind: "operation",
  id: "fixture-operation-point/stamps",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "answer"],
    properties: {
      subject: { type: "string" },
      answer: { enum: ["well-formed", "puts", "fourth-field"] },
      puts: { type: "array" },
    },
  },
  output: true,
  documentation: "answers the plan its own argument names",
  effect: "write",
  authority: null,
};

const CONTRIBUTION = { entry: ENTRY, point: kernelPoint("operation")! };

/** A `put` entry the boundary admits by shape; only a case carries `about`. */
function wellFormedPut(kind: RecordKind): PlannedRecord {
  return kind === "case" ? { kind, value: {}, about: [] } : { kind, value: {} };
}

describe("a contributed operation is invoked with its own arguments and answers a plan the kernel checks at the boundary", () => {
  let scratchDir: string;
  let modulePath: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-operation-point-"));
    modulePath = join(scratchDir, "answers-a-plan.ts");
    await writeFile(modulePath, gatewaySource("invoke", ANSWERS_A_PLAN_BODY));
  });

  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  async function throughEveryHost(input: Record<string, unknown>): Promise<Map<string, EnvelopeResponse>> {
    const responses = new Map<string, EnvelopeResponse>();
    for (const descriptor of HOSTS) {
      if (!(await descriptor.available())) {
        continue;
      }
      const host = descriptor.create();
      try {
        const loaded = await host.load(modulePath, "invoke");
        const { response } = await host.invoke(
          loaded,
          { protocol: ENVELOPE_PROTOCOL, contribution: ENTRY.kind, id: ENTRY.id, version: ENTRY.version, input },
          CONTRIBUTION,
        );
        responses.set(descriptor.name, response);
      } finally {
        await host.close?.();
      }
    }
    expect([...responses.keys()]).toEqual(expect.arrayContaining(["in-process", "subprocess-node"]));
    return responses;
  }

  test("arguments its own entry accepts reach the pack, and a well-formed plan crosses back", async () => {
    const responses = await throughEveryHost({ subject: "the thing asked about", answer: "well-formed" });

    for (const [host, response] of responses) {
      expect(response, host).toMatchObject({
        ok: true,
        output: {
          put: [{ kind: "artifact", value: { echoed: "the thing asked about" } }],
          attest: [{ subject: { put: 0 }, purpose: "made" }],
          needs: [],
        },
      });
    }
  });

  test("a plan putting one record of each kind a pack may draft crosses back whole", async () => {
    const puts = RECORD_KINDS.filter((kind) => KIND_CONTRACTS[kind].packMayDraft).map(wellFormedPut);
    const responses = await throughEveryHost({ subject: "x", answer: "puts", puts });

    for (const [host, response] of responses) {
      expect(response, host).toMatchObject({ ok: true, output: { put: puts } });
    }
  });

  test("a plan asking the kernel to salt each kind a pack may draft crosses back whole", async () => {
    const puts = RECORD_KINDS.filter((kind) => KIND_CONTRACTS[kind].packMayDraft).map((kind) => ({
      ...wellFormedPut(kind),
      salt: true,
    }));
    const responses = await throughEveryHost({ subject: "x", answer: "puts", puts });

    for (const [host, response] of responses) {
      expect(response, host).toMatchObject({ ok: true, output: { put: puts } });
    }
  });

  test("a plan naming anything but true for a salt is refused as invalid output, naming the entry's salt", async () => {
    const puts = [{ ...wellFormedPut("claim"), salt: "5a".repeat(32) }];
    const responses = await throughEveryHost({ subject: "x", answer: "puts", puts });

    for (const [host, response] of responses) {
      expect(response.ok, host).toBe(false);
      if (!response.ok) {
        const paths = (response.error.data as { errors: { instancePath: string }[] }).errors.map(
          (error) => error.instancePath,
        );
        expect(paths, host).toContain("/put/0/salt");
      }
    }
  });

  test("a plan putting a ruling, a run or any kind whose contract lets no pack draft one is refused as invalid output, naming each such entry's kind and no other entry", async () => {
    const puts = RECORD_KINDS.map(wellFormedPut);
    const responses = await throughEveryHost({ subject: "x", answer: "puts", puts });

    for (const [host, response] of responses) {
      expect(response.ok, host).toBe(false);
      if (!response.ok) {
        expect(response.error.code, host).toBe("invalid-output");
        const paths = (response.error.data as { errors: { instancePath: string }[] }).errors.map(
          (error) => error.instancePath,
        );
        for (const [index, { kind }] of puts.entries()) {
          if (KIND_CONTRACTS[kind].packMayDraft) {
            expect(
              paths.filter((path) => path.startsWith(`/put/${index}`)),
              `${host}: ${kind}`,
            ).toEqual([]);
          } else {
            expect(paths, `${host}: ${kind}`).toContain(`/put/${index}/kind`);
          }
        }
      }
    }
    expect(RECORD_KINDS.filter((kind) => !KIND_CONTRACTS[kind].packMayDraft)).toEqual(
      expect.arrayContaining(["ruling", "run"]),
    );
  });

  test("a plan carrying a field beyond put, attest and needs is refused as invalid output, naming the field", async () => {
    const responses = await throughEveryHost({ subject: "x", answer: "fourth-field" });

    for (const [host, response] of responses) {
      expect(response.ok, host).toBe(false);
      if (!response.ok) {
        expect(response.error.code, host).toBe("invalid-output");
        const errors = (response.error.data as { errors: { instancePath: string; params: Record<string, unknown> }[] })
          .errors;
        expect(errors, host).toContainEqual(
          expect.objectContaining({ instancePath: "", params: { additionalProperty: "principal" } }),
        );
      }
    }
  });
});
