import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_ROOT_ENV, corpusRoots } from "./corpus-roots.js";

describe("corpusRoots names every root a workspace reads bug reports from, never a home directory", () => {
  const originalEnv = process.env[CORPUS_ROOT_ENV];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[CORPUS_ROOT_ENV];
    } else {
      process.env[CORPUS_ROOT_ENV] = originalEnv;
    }
  });

  it("returns only the repository's own corpus directory when no external root is named", () => {
    delete process.env[CORPUS_ROOT_ENV];
    expect(corpusRoots("/repo")).toEqual(["/repo/corpus"]);
  });

  it("returns both roots when the environment variable names an external one", () => {
    process.env[CORPUS_ROOT_ENV] = "/elsewhere/bugs";
    expect(corpusRoots("/repo")).toEqual(["/repo/corpus", "/elsewhere/bugs"]);
  });
});
