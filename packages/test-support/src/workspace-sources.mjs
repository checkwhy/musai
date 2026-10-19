import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Each `@musai/<name>` resolves to its source for imports only: a built binary reads dist/, and
 * the module host and scaffold template read their build wherever one exists. */
const PACKAGES = new URL("../../", import.meta.url);
const WORKSPACE_PACKAGE = /^@musai\/([a-z0-9-]+)$/;

export function workspaceSource(specifier) {
  const match = WORKSPACE_PACKAGE.exec(specifier);
  if (!match) {
    return undefined;
  }
  const source = new URL(`${match[1]}/src/index.ts`, PACKAGES);
  return existsSync(source) ? source.href : undefined;
}

/** Each alias is anchored at both ends, so a subpath resolves through its package's exports. */
export function workspaceSourceAliases() {
  const aliases = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    const specifier = `@musai/${entry.name}`;
    const source = entry.isDirectory() ? workspaceSource(specifier) : undefined;
    if (source) {
      aliases.push({ find: new RegExp(`^${specifier}$`), replacement: fileURLToPath(source) });
    }
  }
  return aliases;
}
