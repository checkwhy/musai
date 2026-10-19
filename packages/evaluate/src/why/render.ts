export interface DerivationHop {
  label: string;
  id: string;
  decidedBy: string;
  beat: string | null;
}

export interface DerivationNode {
  hop: DerivationHop;
  children: DerivationNode[];
}

/** `beneath` answers the lines a surface shows under a hop, such as a run's command and output. */
export function renderText(
  root: DerivationNode,
  beneath: (hop: DerivationHop) => readonly string[] = () => [],
): string {
  const lines: string[] = [];

  function walk(node: DerivationNode, depth: number): void {
    const indent = "  ".repeat(depth);
    const beatText = node.hop.beat !== null ? `, beat ${node.hop.beat}` : "";
    lines.push(`${indent}${node.hop.label} ${node.hop.id} — decided by ${node.hop.decidedBy}${beatText}`);
    for (const line of beneath(node.hop)) {
      lines.push(`${indent}  ${line}`);
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return lines.join("\n");
}

export interface DerivationJson {
  label: string;
  id: string;
  decidedBy: string;
  beat: string | null;
  children: DerivationJson[];
}

export function renderJson(root: DerivationNode): DerivationJson {
  function toJson(node: DerivationNode): DerivationJson {
    return {
      label: node.hop.label,
      id: node.hop.id,
      decidedBy: node.hop.decidedBy,
      beat: node.hop.beat,
      children: node.children.map(toJson),
    };
  }
  return toJson(root);
}

export const RULING_HOP_LABEL = "ruling";

/** Every principal behind one ruling is named, so their agreement shows in the derivation. */
export function formatRulingDecision(authority: string, principals: readonly string[]): string {
  return principals.length === 0
    ? `${authority} ruling attested by nobody`
    : `${authority} ruling by ${principals.join(" and ")}`;
}

export const SUPERSEDED_HOP_LABEL = "superseded";

/** The verdict leads: a ruling deciding nothing, retired or contested, is read for what it said. */
export function formatRulingVerdict(verdict: string, authority: string, principals: readonly string[]): string {
  return `${verdict}, ${formatRulingDecision(authority, principals)}`;
}

export const SET_ASIDE_HOP_LABEL = "set-aside";

export function formatSetAsideDecision(principal: string, reason: string): string {
  return `overruled by ${principal}: ${reason}`;
}

export const FLOOR_HOP_LABEL = "floor";

/** A floor is standing configuration, so its hop names the commit and no principal or reason. */
export function formatFloorDecision(commit: string): string {
  return `floor declared at ${commit}`;
}

export const BRIEF_HOP_LABEL = "brief";

/** A brief is the record a ruling cites, never a decision, so its hop names no principal. */
export function formatBriefDecision(): string {
  return "cited by the ruling";
}
