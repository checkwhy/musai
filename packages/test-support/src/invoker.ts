import type { Rule, RuleInput } from "@musai/modules";
import { ENVELOPE_PROTOCOL, type Invoker, readLogForRequest } from "@musai/modules";
import { versionString } from "@musai/records";

/** Carries the read log a host's invocation would; the contribution id and version are nominal. */
export function invokerFromRule(rule: Rule): Invoker {
  return {
    invoke: async (input: RuleInput) => ({
      output: rule(input, Object.freeze({}) as Record<string, never>),
      readLog: readLogForRequest({
        protocol: ENVELOPE_PROTOCOL,
        contribution: "rule",
        id: "support/rule",
        version: versionString("1"),
        input,
      }),
    }),
  };
}
