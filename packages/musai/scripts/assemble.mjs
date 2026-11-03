#!/usr/bin/env node
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read at run time from beside the bundle, as each workspace package reads its own. */
const COPIED = [
  ["node_modules/@musai/distribution/dist/artefacts", "dist/artefacts"],
  ["node_modules/@musai/devkit/dist/templates", "dist/templates"],
];

/** Workspace-only fields: the bundle depends on its bundler alone, an install runs no script of
 * ours, and only the staged directory, which `pnpm pack` and `pnpm publish` read, is published. */
const UNPUBLISHED = ["private", "devDependencies", "scripts", "publishConfig"];

const METAFILE = "dist/metafile-esm.json";
const NOTICES = "THIRD_PARTY_NOTICES";

/** Licences a notice shipped beside the copy satisfies. */
const ALLOWED_LICENCES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0"]);

/** Third-party code a workspace package carries as a copy, which no bundle input names. */
const CARRIED = ["../records/node_modules/ajv"];

const INSTALLED = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i;

const root = fileURLToPath(new URL("..", import.meta.url));

async function bundledPackageDirs() {
  const metafile = JSON.parse(await readFile(join(root, METAFILE), "utf8"));
  const dirs = [...CARRIED];
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const installed = INSTALLED.exec(input);
      if (installed !== null && bytesInOutput > 0) {
        dirs.push(installed[1]);
      }
    }
  }
  return new Set(await Promise.all(dirs.map((dir) => realpath(join(root, dir)))));
}

async function noticeOf(dir) {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const licence = typeof manifest.license === "string" ? manifest.license : "no SPDX licence id";
  const files = (await readdir(dir)).filter((file) => LICENCE_FILE.test(file)).sort();
  const texts = await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
  const text =
    texts.length > 0
      ? texts.map((body) => body.replace(/\r\n?/g, "\n").trimEnd()).join("\n\n")
      : `Licensed under ${licence}; the package ships no licence file.`;
  return { name: manifest.name, version: manifest.version, licence, text };
}

const byPackage = new Map();
for (const dir of await bundledPackageDirs()) {
  const notice = await noticeOf(dir);
  byPackage.set(`${notice.name}@${notice.version}`, notice);
}
const notices = [...byPackage.values()].sort((a, b) =>
  a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
);
const refused = notices.filter(({ licence }) => !ALLOWED_LICENCES.has(licence));
if (refused.length > 0) {
  const named = refused.map(({ name, version, licence }) => `${name} ${version} (${licence})`);
  process.stderr.write(`assemble: refused, bundled under a licence off the allow-list: ${named.join(", ")}\n`);
  process.exit(1);
}
const licences = [...new Set(notices.map(({ licence }) => licence))].sort();
process.stdout.write(`assemble: ${notices.length} bundled packages, under ${licences.join(", ")}\n`);

for (const [from, to] of COPIED) {
  await cp(join(root, from), join(root, to), { recursive: true, dereference: true });
}

const staged = join(root, "pack");
await rm(staged, { recursive: true, force: true });
await mkdir(staged);
const metafile = join(root, METAFILE);
await cp(join(root, "dist"), join(staged, "dist"), { recursive: true, filter: (source) => source !== metafile });
// The repository's README and licence are the package's, so npm and the clone show one of each.
for (const file of ["README.md", "LICENSE"]) {
  await copyFile(join(root, "..", "..", file), join(staged, file));
}
const sections = notices.map(
  ({ name, version, licence, text }) => `==== ${name} ${version} (${licence}) ====\n\n${text}\n`,
);
await writeFile(
  join(staged, NOTICES),
  `checkwhy carries code from the packages below, each under the licence that follows its name.\n\n${sections.join("\n")}`,
);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const field of UNPUBLISHED) {
  delete manifest[field];
}
await writeFile(join(staged, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
