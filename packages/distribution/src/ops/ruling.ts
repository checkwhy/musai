import {
  definedOperation,
  establishedChannel,
  MINTED_ARRAY_SCHEMA,
  type OperationHandler,
  SALT_INPUT_SCHEMA,
  type WriteResult,
} from "@musai/api-core";
import { type RecordId, versionString } from "@musai/records";
import { mintRuling } from "../gate/ruling-mint.js";

export interface RulingMakeInput {
  readonly claim: string;
  readonly verdict: "holds" | "fails";
  readonly reason: string;
  readonly brief: string;
  /** The live rulings on the same claim this one supersedes. */
  readonly supersedes?: readonly string[];
  /** A private key to sign this ruling with, outranking any configured or registered key. */
  readonly key?: string;
  readonly salt?: boolean;
}

export type RulingMakeOutput = WriteResult;

function renderRulingMakeText(output: RulingMakeOutput): string {
  return output.minted.map((item) => item.id).join("\n");
}

const rulingMakeHandler: OperationHandler<RulingMakeInput, RulingMakeOutput> = {
  async plan(input, opened, context) {
    const { via, principal } = await establishedChannel(context, opened, input.key);
    const planned = await mintRuling(opened, {
      claim: input.claim as RecordId,
      verdict: input.verdict,
      reason: input.reason,
      brief: input.brief as RecordId,
      supersedes: (input.supersedes ?? []) as readonly RecordId[],
      via,
      principal,
      salt: input.salt,
    });
    return {
      plan: { put: planned.put, attest: planned.attest, needs: [] },
      output: (applied) => ({ minted: applied.minted }),
      key: input.key,
    };
  },
};

/** `ruling.make@2`: mints a ruling directly through `mintRuling`, the same commit a gate's answer
 * makes. Naming superseded rulings is how a mistaken ruling is corrected. */
export const rulingMake = definedOperation<RulingMakeInput, RulingMakeOutput>(
  {
    id: "ruling.make",
    version: versionString("2"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["claim", "verdict", "reason", "brief"],
      properties: {
        claim: { type: "string" },
        verdict: { enum: ["holds", "fails"] },
        reason: { type: "string" },
        brief: { type: "string" },
        supersedes: { type: "array", items: { type: "string" }, uniqueItems: true },
        key: { type: "string" },
        salt: SALT_INPUT_SCHEMA,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
      },
    },
    effect: "write",
    authority: "rule",
    reasons: [
      "sibling-conflict",
      "not-authorised",
      "head-moved",
      "inapplicable",
      "no-such-record",
      "declaration-conflict",
      "invalid-input",
    ],
    documentation: "Mints a ruling and its attestation directly, against a claim and the brief it was decided against.",
    paths: ["key"],
    cli: {
      verb: "rule",
      positional: ["claim"],
      flags: ["verdict", "reason", "brief", "supersedes", "key", "salt"],
      describe: "rule a claim directly, minting one ruling and its attestation",
    },
    renderText: renderRulingMakeText,
    exitCode: () => 0,
  },
  rulingMakeHandler,
);
