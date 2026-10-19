#!/usr/bin/env node
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read at run time from beside the bundle, as each workspace package reads its own. */
const COPIED = [
  ["node_modules/@musai/distribution/dist/artefacts", "dist/artefacts"],
  ["node_modules/@musai/devkit/dist/templates", "dist/templates"],
];

/** Workspace-only fields: the bundle depends on nothing, an install runs no script of ours, and
 * only the staged directory, which `pnpm pack` and `pnpm publish` read, may be published. */
const UNPUBLISHED = ["private", "devDependencies", "scripts", "publishConfig"];

const root = fileURLToPath(new URL("..", import.meta.url));
for (const [from, to] of COPIED) {
  await cp(join(root, from), join(root, to), { recursive: true, dereference: true });
}

const staged = join(root, "pack");
await rm(staged, { recursive: true, force: true });
await mkdir(staged);
await cp(join(root, "dist"), join(staged, "dist"), { recursive: true });
// The repository's README and licence are the package's, so npm and the clone show one of each.
for (const file of ["README.md", "LICENSE"]) {
  await copyFile(join(root, "..", "..", file), join(staged, file));
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const field of UNPUBLISHED) {
  delete manifest[field];
}
await writeFile(join(staged, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
