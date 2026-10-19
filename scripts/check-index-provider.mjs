#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The provider's own module, not the fold's barrel, so a red leg is about the engine alone. A URL,
 * since a dynamic import of a bare path is refused where a path is not also a URL. */
const providerModule = new URL("../packages/fold/dist/sqlite-provider.js", import.meta.url);
const { checkIndexProvider, openIndexProvider } = await import(providerModule.href);

const provider = openIndexProvider();
const scratchDir = await mkdtemp(join(tmpdir(), "musai-index-provider-"));
let failures;
try {
  failures = checkIndexProvider(provider, join(scratchDir, "conformance.sqlite"));
} finally {
  await rm(scratchDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`index provider: ${failure}`);
  }
  process.exit(1);
}
const capabilities = [...provider.capabilities()];
const offered = capabilities.length > 0 ? capabilities.join(", ") : "nothing beyond plain SQL";
console.log(`index provider: ${provider.name} passes the contract, offering ${offered}`);
