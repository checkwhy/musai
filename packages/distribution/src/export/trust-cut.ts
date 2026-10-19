import { parseAudiences, reachedFrom } from "@musai/trust";

/** What a bundle's signatures and releases need of the workspace's trust files. */
export interface TrustNeeds {
  readonly signers: ReadonlySet<string>;
  readonly releasedTo: ReadonlySet<string>;
  readonly audience: string;
}

function significantLines(content: string): string[] {
  return content.split("\n").filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
}

function fieldsOf(line: string): string[] {
  return line.trim().split(/\s+/);
}

function joined(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

// A line's principals field is a comma list in OpenSSH's format; musai matches each exactly.
function cutAllowedSigners(content: string, needs: TrustNeeds): string {
  return joined(
    significantLines(content).filter((line) =>
      fieldsOf(line)[0]!
        .split(",")
        .some((principal) => needs.signers.has(principal)),
    ),
  );
}

function cutRoles(content: string, needs: TrustNeeds): string {
  return joined(significantLines(content).filter((line) => needs.signers.has(fieldsOf(line)[0]!)));
}

// A member line matters only where the bundle's own audience is that member.
function cutAudiences(content: string, needs: TrustNeeds): string {
  const declared = parseAudiences(content);
  const reached = new Set([...needs.releasedTo].flatMap((name) => [...reachedFrom(declared, name)]));
  return joined(
    significantLines(content).filter((line) => {
      const [name, relation, other] = fieldsOf(line);
      return reached.has(name!) && (relation !== "member" || other === needs.audience);
    }),
  );
}

export type TrustFileName = "allowed-signers" | "roles" | "audiences";

const CUTS: Readonly<Record<TrustFileName, (content: string, needs: TrustNeeds) => string>> = {
  "allowed-signers": cutAllowedSigners,
  roles: cutRoles,
  audiences: cutAudiences,
};

/** A trust file cut to the lines a receiver needs, so an export names no one it does not carry. */
export function cutTrustFile(name: TrustFileName, content: string, needs: TrustNeeds): string {
  return CUTS[name](content, needs);
}
