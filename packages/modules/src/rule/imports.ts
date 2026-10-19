export const RULE_CONTRACT_SPECIFIER_SUFFIX = "rule/contract.js";

/** Reported for a template interpolation, since the scan cannot see what one reaches for. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the specifier this scan reports for a template literal's own interpolation, not an interpolation itself
export const INTERPOLATION_SPECIFIER = "${...}";

/** A dependency the contract does not permit, by specifier and line. */
export interface ImportViolation {
  readonly specifier: string;
  readonly line: number;
}

interface DeclaredDependency {
  readonly specifier: string;
  readonly offset: number;
  readonly permitted: boolean;
}

type MatchWithIndices = RegExpMatchArray & { readonly indices: ReadonlyArray<readonly [number, number] | undefined> };

function indicesOf(match: RegExpMatchArray): ReadonlyArray<readonly [number, number] | undefined> {
  return (match as unknown as MatchWithIndices).indices;
}

interface MaskedSource {
  readonly masked: string;
  /** The offset of every `${` that opens an interpolation inside a template literal. */
  readonly interpolations: readonly number[];
}

/** The source with comments and literal contents blanked in place, so a specifier in prose is not
 * read as a dependency. An interpolation is blanked too, and reported by offset. */
function maskCommentsAndLiterals(source: string): MaskedSource {
  const out: string[] = [];
  const interpolations: number[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i]!;
    const next = i + 1 < n ? source[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < n && source[i] !== quote) {
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          interpolations.push(i);
        }
        if (source[i] === "\\" && i + 1 < n) {
          out.push(source[i] === "\n" ? "\n" : "x");
          i++;
          out.push(source[i] === "\n" ? "\n" : "x");
          i++;
          continue;
        }
        out.push(source[i] === "\n" ? "\n" : "x");
        i++;
      }
      if (i < n) {
        out.push(quote);
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return { masked: out.join(""), interpolations };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
    }
  }
  return line;
}

/** Every static `import` or `export` with a `from` clause. A re-export is never permitted: it
 * would widen what a rule's importers reach beyond the contract. */
function findStaticDependencies(source: string, masked: string): DeclaredDependency[] {
  const found: DeclaredDependency[] = [];
  const pattern = /\b(import|export)\s+(type\s+)?[^;]*?\bfrom\b\s*(['"`])([\s\S]*?)\3/dg;
  for (const match of masked.matchAll(pattern)) {
    const specifierRange = indicesOf(match)[4];
    if (specifierRange === undefined || match.index === undefined) {
      continue;
    }
    const keyword = match[1];
    const isTypeOnly = Boolean(match[2]);
    const specifier = source.slice(specifierRange[0], specifierRange[1]);
    const permitted = keyword === "import" && isTypeOnly && specifier.endsWith(RULE_CONTRACT_SPECIFIER_SUFFIX);
    found.push({ specifier, offset: match.index, permitted });
  }
  return found;
}

/** A bare `import '<specifier>';`, never permitted. */
function findSideEffectImports(source: string, masked: string): DeclaredDependency[] {
  const found: DeclaredDependency[] = [];
  const pattern = /\bimport\s*(['"`])([\s\S]*?)\1/dg;
  for (const match of masked.matchAll(pattern)) {
    const specifierRange = indicesOf(match)[2];
    if (specifierRange === undefined || match.index === undefined) {
      continue;
    }
    const specifier = source.slice(specifierRange[0], specifierRange[1]);
    found.push({ specifier, offset: match.index, permitted: false });
  }
  return found;
}

function leadingQuotedLiteral(source: string, masked: string, from: number): string | undefined {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i]!)) {
    i++;
  }
  const quote = masked[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") {
    return undefined;
  }
  const start = i + 1;
  let j = start;
  while (j < masked.length && masked[j] !== quote) {
    j++;
  }
  return source.slice(start, j);
}

/** Every `import(...)` or `require(...)` call, never permitted; a computed argument is reported
 * as the call itself. */
function findCallStyleDependencies(
  source: string,
  masked: string,
  keyword: "import" | "require",
): DeclaredDependency[] {
  const found: DeclaredDependency[] = [];
  const marker = new RegExp(`\\b${keyword}\\s*\\(`, "g");
  for (const match of masked.matchAll(marker)) {
    if (match.index === undefined) {
      continue;
    }
    const afterParen = match.index + match[0].length;
    const literal = leadingQuotedLiteral(source, masked, afterParen);
    found.push({ specifier: literal ?? `${keyword}(...)`, offset: match.index, permitted: false });
  }
  return found;
}

/** Every dependency a rule's source declares but a type-only `import` of the contract, erring
 * closed. It backs the vm context rather than replacing it: each misses what the other catches. */
export function checkRuleImports(source: string): readonly ImportViolation[] {
  const { masked, interpolations } = maskCommentsAndLiterals(source);
  const dependencies = [
    ...findStaticDependencies(source, masked),
    ...findSideEffectImports(source, masked),
    ...findCallStyleDependencies(source, masked, "import"),
    ...findCallStyleDependencies(source, masked, "require"),
  ];
  const violations: ImportViolation[] = [];
  for (const dependency of dependencies) {
    if (dependency.permitted) {
      continue;
    }
    violations.push({ specifier: dependency.specifier, line: lineAt(source, dependency.offset) });
  }
  for (const offset of interpolations) {
    violations.push({ specifier: INTERPOLATION_SPECIFIER, line: lineAt(source, offset) });
  }
  violations.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return violations;
}
