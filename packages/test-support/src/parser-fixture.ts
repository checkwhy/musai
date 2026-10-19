import { join } from "node:path";
import { installModule } from "@musai/modules";
import {
  type Clock,
  type ContributionEntry,
  type ModuleManifest,
  recordId,
  type Selector,
  versionString,
} from "@musai/records";
import { GitBlobStore, MUSAI_DIR, Store } from "@musai/store";
import { gatewaySource } from "./gateway-source.js";
import { foldedIndex, manifestWithContributions } from "./module-fixtures.js";

/** No pack ships a module of this name. */
export const PARSER_FIXTURE_MODULE = "fixture-parsers";

export const PARSER_FIXTURE_SELECTOR: Selector = {
  module: PARSER_FIXTURE_MODULE,
  parser: "exit-code",
  version: versionString("1"),
  key: "exitCode",
};

/** Answers as the core module's `exit-code` parser does, so an admitted edge names the content id
 * of the cited run's exit code. */
export const PARSER_FIXTURE_SOURCE = gatewaySource("invoke", "      return { exitCode: input.exitCode };");

const EXIT_CODE_PARSER: ContributionEntry = {
  kind: "parser",
  id: `${PARSER_FIXTURE_SELECTOR.module}/${PARSER_FIXTURE_SELECTOR.parser}`,
  version: PARSER_FIXTURE_SELECTOR.version,
  input: {
    type: "object",
    additionalProperties: false,
    required: ["output", "exitCode"],
    properties: { output: { type: "string" }, exitCode: { type: "number" } },
  },
  output: true,
  documentation: "selects the observation's own exit code",
};

export function parserFixtureManifest(): ModuleManifest {
  return manifestWithContributions([EXIT_CODE_PARSER]);
}

/** Its build receipt is an id no record carries, since nothing an admission reads follows it. */
export async function installParserFixture(workspace: string, scope: string, now: Clock): Promise<void> {
  const ctx = { gitDir: join(workspace, MUSAI_DIR) };
  const store = new Store({ ctx, scope, now });
  await installModule(
    PARSER_FIXTURE_MODULE,
    versionString("1.0.0"),
    parserFixtureManifest(),
    new TextEncoder().encode(PARSER_FIXTURE_SOURCE),
    recordId({ marker: `build-for-${PARSER_FIXTURE_MODULE}` }),
    store,
    new GitBlobStore({ ctx, now }),
    await foldedIndex(store),
  );
}
