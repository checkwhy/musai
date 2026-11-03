import { isKernelError, type KernelError, TrustFileError } from "@musai/records";
import type { TrustBranch } from "@musai/store";
import { parseAllowedSigners } from "./allowed-signers.js";
import { parseAudiences, setAsideAudiencesLine } from "./audiences.js";
import { parseRoles } from "./roles.js";

type LineFiles = Pick<TrustBranch, "allowedSigners" | "roles" | "audiences">;

interface LineReader {
  readonly parse: (content: string) => unknown;
  /** What stands in a refused line's place: whatever later lines may rely on it declaring. */
  readonly setAside: (rawLine: string) => string;
}

const DROPPED = (): string => "";

const READERS: readonly (readonly [keyof LineFiles, LineReader])[] = [
  ["allowedSigners", { parse: parseAllowedSigners, setAside: DROPPED }],
  ["roles", { parse: parseRoles, setAside: DROPPED }],
  ["audiences", { parse: parseAudiences, setAside: setAsideAudiencesLine }],
];

/** Read again with each refused line set aside, so a file's every bad line is named at once; a
 * refusal of the whole file ends its reading. */
function faultsOf(content: string, { parse, setAside }: LineReader): KernelError[] {
  const lines = content.split("\n");
  const faults: KernelError[] = [];
  for (;;) {
    try {
      parse(lines.join("\n"));
      return faults;
    } catch (error) {
      if (!isKernelError(error)) {
        throw error;
      }
      faults.push(error);
      if (!(error instanceof TrustFileError) || error.line === null) {
        return faults;
      }
      lines[error.line - 1] = setAside(lines[error.line - 1]!);
    }
  }
}

// A whole-file refusal ends a file's reading, so it is its last fault and sorts last.
function lineOf(fault: KernelError): number {
  return fault instanceof TrustFileError && fault.line !== null ? fault.line : Number.POSITIVE_INFINITY;
}

/** Every refusal the trust branch's line files hold, in file and line order. */
export function trustFileFaults(trust: LineFiles): readonly KernelError[] {
  return READERS.flatMap(([field, reader]) =>
    faultsOf(trust[field], reader).sort((left, right) => lineOf(left) - lineOf(right)),
  );
}
