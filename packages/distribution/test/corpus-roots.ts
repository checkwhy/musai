import { join } from "node:path";
import type { WorkspaceConfig } from "@musai/store";

/** Names the author's external corpus root, so no home-directory literal enters a source file. */
export const CORPUS_ROOT_ENV = "MUSAI_CORPUS_DIR";

/** The workspace configuration key naming the same root when the environment leaves it unset. */
const CORPUS_ROOT_CONFIG_KEY = "corpus.root";

function externalCorpusRoot(config: WorkspaceConfig | undefined): string | undefined {
  const fromEnv = process.env[CORPUS_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const fromConfig = config?.values[CORPUS_ROOT_CONFIG_KEY];
  return typeof fromConfig === "string" && fromConfig.length > 0 ? fromConfig : undefined;
}

/** The repository's `corpus/` and any named external root, returned whether or not it exists so a
 * caller reports a missing root by name. */
export function corpusRoots(repoRoot: string, config?: WorkspaceConfig): readonly string[] {
  const roots = [join(repoRoot, "corpus")];
  const external = externalCorpusRoot(config);
  if (external !== undefined) {
    roots.push(external);
  }
  return roots;
}
