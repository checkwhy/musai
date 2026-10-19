import type { AnchorGrammar } from "./grammar.js";
import { markdownGrammar } from "./markdown.js";

/** Every anchor grammar this distribution ships; a format resolves to at most one. */
export const ANCHOR_GRAMMARS: readonly AnchorGrammar[] = [markdownGrammar];

/** Raised when a format has no installed anchor grammar, which an empty anchor list could not
 * tell apart from a document that anchors nothing. */
export class UngrammaredFormatError extends Error {
  readonly format: string;

  constructor(format: string) {
    super(`no anchor grammar is installed for format ${JSON.stringify(format)}`);
    this.name = "UngrammaredFormatError";
    this.format = format;
  }
}

export function anchorGrammarFor(format: string): AnchorGrammar {
  const grammar = ANCHOR_GRAMMARS.find((candidate) => candidate.format === format);
  if (grammar === undefined) {
    throw new UngrammaredFormatError(format);
  }
  return grammar;
}
