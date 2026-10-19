#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUDED, LAYERS, ROLES, TYPE_ONLY } from "./package-roles.mjs";
import { codeOnly, importsIn } from "./source-text.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

const SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs"];
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"];

/** Relative to the scan root, with forward slashes on every platform. */
function displayPath(path) {
  return relative(scanRoot, path).split(sep).join("/");
}

/** Presence alone counts: a package.json that does not parse is still there. */
async function holdsPackageJson(dir) {
  try {
    await readFile(join(dir, "package.json"));
    return true;
  } catch {
    return false;
  }
}

/** Outside a `src/`, `dist` and `packages` are build output or fixture trees. A nested package's
 * files declare nothing to this one, so `skipNestedPackages` passes over them. */
async function filesUnderPackage(packageRoot, { skipNestedPackages = false } = {}) {
  const files = [];
  async function walk(dir, underSrc) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || (!underSrc && (entry.name === "dist" || entry.name === "packages"))) {
          continue;
        }
        if (skipNestedPackages && (await holdsPackageJson(path))) {
          continue;
        }
        await walk(path, underSrc || entry.name === "src");
      } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(path);
      }
    }
  }
  await walk(packageRoot, basename(packageRoot) === "src");
  return files;
}

/** Every directory under packages/, manifest or not: the layer rule reads source without one. */
async function discoverPackages() {
  const packagesRoot = join(scanRoot, "packages");
  let entries;
  try {
    entries = await readdir(packagesRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const packages = [];
  for (const dir of dirs) {
    const path = join(packagesRoot, dir);
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    } catch {
      manifest = null;
    }
    packages.push({ dir, path, manifest, role: ROLES.get(dir) });
  }
  return packages;
}

// `"dist-alias": "workspace:@musai/distribution@*"` links that package under the key `dist-alias`.
const WORKSPACE_ALIAS = /^workspace:((?:@[^/@]+\/)?[^/@]+)@/;

/** Each declaration naming a workspace package: by its spec when an alias, else by its key. */
function* workspaceDeclarations(manifest, packagesByName, fields) {
  for (const field of fields) {
    for (const [key, spec] of Object.entries(manifest?.[field] ?? {})) {
      const target = packagesByName.get(WORKSPACE_ALIAS.exec(spec)?.[1] ?? key);
      if (target) {
        yield { key, field, target };
      }
    }
  }
}

/** Keyed by the declared package's own name, whatever key the manifest lists it under. */
function declaredWorkspaceDeps(manifest, packagesByName, fields) {
  return new Map(
    [...workspaceDeclarations(manifest, packagesByName, fields)].map(({ field, target }) => [
      target.manifest.name,
      { field, target },
    ]),
  );
}

/** Every package's own name, plus each key the manifest of `pkg` declares one under. */
function workspaceNamesSeenFrom(pkg, packagesByName) {
  const names = new Map(packagesByName);
  for (const { key, target } of workspaceDeclarations(pkg.manifest, packagesByName, DEPENDENCY_FIELDS)) {
    names.set(key, target);
  }
  return names;
}

function workspacePackageFor(specifier, names) {
  for (const [name, pkg] of names) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return pkg;
    }
  }
  return undefined;
}

function packageNameOf(specifier) {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function isPlatformModule(specifier) {
  return (
    specifier.startsWith("node:") || specifier.startsWith("bun:") || builtinModules.includes(packageNameOf(specifier))
  );
}

async function everyPackageHasARole(packages) {
  const unroled = [];
  for (const pkg of packages.filter((candidate) => candidate.role === undefined)) {
    if ((await holdsPackageJson(pkg.path)) || (await filesUnderPackage(pkg.path)).length > 0) {
      unroled.push(displayPath(pkg.path));
    }
  }
  return unroled;
}

/** A type-only import counts: under src/ it lands in the declarations a consumer typechecks. */
async function importsAreDeclared(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages) {
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    for (const file of await filesUnderPackage(pkg.path, { skipNestedPackages: true })) {
      const underSrc = relative(pkg.path, file).split(sep)[0] === "src";
      const fields = underSrc
        ? ["dependencies", "peerDependencies"]
        : ["dependencies", "peerDependencies", "devDependencies"];
      const declaredKeys = new Set(fields.flatMap((field) => Object.keys(pkg.manifest?.[field] ?? {})));
      const allowed = new Set([
        pkg.manifest?.name,
        ...declaredWorkspaceDeps(pkg.manifest, packagesByName, fields).keys(),
      ]);
      if (!underSrc) {
        // The helper depends on the kernel side, so declaring it there would close a cycle.
        allowed.add("@musai/test-support");
      }
      for (const { specifier, line } of importsIn(await readFile(file, "utf8"))) {
        if (specifier.startsWith(".") || isPlatformModule(specifier)) {
          continue;
        }
        const target = workspacePackageFor(specifier, names);
        if (target ? allowed.has(target.manifest.name) : declaredKeys.has(packageNameOf(specifier))) {
          continue;
        }
        violations.push(`${displayPath(file)}:${line} imports ${specifier} (not declared in ${pkg.dir}/package.json)`);
      }
    }
  }
  return violations;
}

async function relativeImportsStayInTheirPackage(packages) {
  const violations = [];
  for (const pkg of packages) {
    for (const file of await filesUnderPackage(pkg.path)) {
      for (const { specifier, line } of importsIn(await readFile(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const target = resolve(dirname(file), specifier);
        if (target !== pkg.path && !target.startsWith(`${pkg.path}${sep}`)) {
          violations.push(`${displayPath(file)}:${line} imports ${specifier} (outside ${displayPath(pkg.path)})`);
        }
      }
    }
  }
  return violations;
}

function declaredGraphIsAcyclic(packages, packagesByName) {
  const edges = new Map(packages.map((pkg) => [pkg.dir, new Set()]));
  for (const pkg of packages) {
    for (const { target } of declaredWorkspaceDeps(pkg.manifest, packagesByName, DEPENDENCY_FIELDS).values()) {
      edges.get(pkg.dir).add(target.dir);
    }
  }

  const cycles = new Set();
  const stack = [];
  const onStack = new Set();
  const visited = new Set();

  function visit(node) {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (onStack.has(next)) {
        const start = stack.indexOf(next);
        cycles.add(normalizeCycle(stack.slice(start)));
      } else if (!visited.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  }

  function normalizeCycle(path) {
    const smallest = [...path].sort()[0];
    const at = path.indexOf(smallest);
    const rotated = [...path.slice(at), ...path.slice(0, at)];
    return [...rotated, rotated[0]].join(" > ");
  }

  for (const dir of [...edges.keys()].sort()) {
    if (!visited.has(dir)) {
      visit(dir);
    }
  }
  return [...cycles].sort();
}

/** Reads no source: with the edge undeclared, `imports-are-declared` refuses any import of it. */
function excludedEdgesStayUndeclared(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages) {
    const excluded = EXCLUDED.get(pkg.dir) ?? [];
    for (const [depName, { field, target }] of declaredWorkspaceDeps(pkg.manifest, packagesByName, DEPENDENCY_FIELDS)) {
      if (excluded.includes(target.dir)) {
        violations.push(`${displayPath(join(pkg.path, "package.json"))} declares ${depName} in ${field} (excluded)`);
      }
    }
  }
  return violations;
}

/** Declarations, and imports under src/, from a `fromRole` package into a `forbiddenRoles` one. */
async function reachesInto(packages, packagesByName, fromRole, forbiddenRoles) {
  const violations = [];
  for (const pkg of packages.filter((candidate) => candidate.role === fromRole)) {
    for (const [depName, { field, target }] of declaredWorkspaceDeps(pkg.manifest, packagesByName, DEPENDENCY_FIELDS)) {
      if (forbiddenRoles.has(target.role)) {
        violations.push(
          `${displayPath(join(pkg.path, "package.json"))} declares ${depName} in ${field} (${target.role})`,
        );
      }
    }
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    for (const file of await filesUnderPackage(join(pkg.path, "src"))) {
      for (const { specifier, line } of importsIn(await readFile(file, "utf8"))) {
        const target = workspacePackageFor(specifier, names);
        if (target && forbiddenRoles.has(target.role)) {
          violations.push(`${displayPath(file)}:${line} imports ${specifier}`);
        }
      }
    }
  }
  return violations;
}

const SHIPPED_ROLES = new Set(["kernel-side", "surface", "distribution", "package"]);
const NEVER_SHIPPED_ROLES = new Set(["test", "scenarios", "content"]);

/** The test helper would break an install: it exports TypeScript source and imports the runner. */
function neverShippedPackagesStayUndeclared(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages.filter((candidate) => SHIPPED_ROLES.has(candidate.role))) {
    for (const [depName, { field, target }] of declaredWorkspaceDeps(pkg.manifest, packagesByName, DEPENDENCY_FIELDS)) {
      if (NEVER_SHIPPED_ROLES.has(target.role)) {
        violations.push(
          `${displayPath(join(pkg.path, "package.json"))} declares ${depName} in ${field} (${target.role})`,
        );
      }
    }
  }
  return violations;
}

async function surfacesDeclareOnlyTheKernelSidePackagesTheyImport(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages.filter((candidate) => candidate.role === "surface")) {
    const srcRoot = join(pkg.path, "src");
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    const imported = new Set();
    for (const file of await filesUnderPackage(srcRoot)) {
      for (const { specifier } of importsIn(await readFile(file, "utf8"))) {
        const target = workspacePackageFor(specifier, names);
        if (target) {
          imported.add(target.manifest.name);
        }
      }
    }
    for (const [depName, { field, target }] of declaredWorkspaceDeps(pkg.manifest, packagesByName, [
      "dependencies",
      "peerDependencies",
    ])) {
      if (target.role === "kernel-side" && !imported.has(depName)) {
        violations.push(
          `${displayPath(join(pkg.path, "package.json"))} declares ${depName} in ${field}, which nothing under ${displayPath(srcRoot)} imports`,
        );
      }
    }
  }
  return violations;
}

async function scenariosReachTheKernelOnlyBySpawningIt(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages.filter((candidate) => candidate.role === "scenarios")) {
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    for (const file of await filesUnderPackage(pkg.path)) {
      for (const { specifier, line } of importsIn(await readFile(file, "utf8"))) {
        const target = workspacePackageFor(specifier, names);
        if (target && target.role !== "test") {
          violations.push(`${displayPath(file)}:${line} imports ${specifier}`);
        }
      }
    }
  }
  return violations;
}

async function directoriesFormOneLayeredGraph(packages) {
  const packagesByDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const violations = [];
  for (const [name, layers] of LAYERS) {
    const pkg = packagesByDir.get(name);
    if (!pkg) {
      continue;
    }
    const layerOf = new Map(layers.flatMap((names, rank) => names.map((layerName) => [layerName, rank])));
    const root = join(pkg.path, "src");
    for (const file of await filesUnderPackage(root)) {
      const from = relative(root, file).split(sep)[0];
      const fromRank = layerOf.get(from);
      if (fromRank === undefined) {
        continue;
      }
      for (const { specifier, line } of importsIn(await readFile(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const target = relative(root, resolve(dirname(file), specifier)).split(sep)[0];
        const targetRank = layerOf.get(target);
        if (targetRank === undefined || target === from || targetRank < fromRank) {
          continue;
        }
        violations.push(`${displayPath(file)}:${line} imports ${specifier} (${from} may import only from below it)`);
      }
    }
  }
  return violations;
}

async function typeOnlyEdgesCarryOnlyTypes(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages) {
    const typeOnlyTargets = TYPE_ONLY.get(pkg.dir) ?? [];
    if (typeOnlyTargets.length === 0) {
      continue;
    }
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    for (const file of await filesUnderPackage(join(pkg.path, "src"))) {
      for (const { specifier, line, typeOnly } of importsIn(await readFile(file, "utf8"))) {
        const target = workspacePackageFor(specifier, names);
        if (!target || !typeOnlyTargets.includes(target.dir) || typeOnly) {
          continue;
        }
        violations.push(`${displayPath(file)}:${line} imports ${specifier} for more than its types`);
      }
    }
  }
  return violations;
}

const BARREL_HELD_ROLES = new Set(["kernel-side", "surface"]);

// `import` or `export` as a word, and not the `import` of `import.meta` or of a call.
const STATEMENT_HEAD = /(?<![\w$.])(?:import|export)(?![\w$])(?!\s*[.(])/g;
// The clause holds no `;`, so a head with no `from` never borrows a later statement's.
const HEAD_TO_FROM = /^(import|export)(?:\s+type(?![\w$]))?\s*([^;]*?)\s*(?<![\w$.])from\s*["']/;
// An export clause naming bindings of the file's own scope: no `from` follows it.
const LOCAL_EXPORT_CLAUSE = /(?<![\w$.])export(?:\s+type(?![\w$]))?\s*\{([^}]*)\}(?!\s*from(?![\w$]))/g;

/** A `{ … }` clause's entries as written, `a` or `a as b`, each without its `type`. */
function clauseEntries(inner) {
  return inner
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replace(/\s+/g, " ")
        .replace(/^type (?=\S)/, ""),
    )
    .filter((entry) => entry !== "");
}

/** The local names an import clause binds: default, namespace and each named entry's. */
function importedBindings(clause) {
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = clause
    .replace(/\{[^}]*\}/, "")
    .split(",")
    .map((part) => part.trim().replace(/^\*\s*as\s+/, ""))
    .filter((name) => name !== "");
  const named = braces ? clauseEntries(braces[1]).map((entry) => entry.split(" as ").at(-1)) : [];
  return [...outside, ...named];
}

/** An alias by declaration (`export const x = y`, `export type X = Y`, `export default y`) is
 * read as a name of the file's own. */
async function barrelsCarryOnlyTheirOwnNames(packages, packagesByName) {
  const violations = [];
  for (const pkg of packages.filter((candidate) => BARREL_HELD_ROLES.has(candidate.role))) {
    const names = workspaceNamesSeenFrom(pkg, packagesByName);
    for (const file of await filesUnderPackage(join(pkg.path, "src"))) {
      const text = await readFile(file, "utf8");
      const code = codeOnly(text);
      const lineStarts = [0, ...[...code.matchAll(/\n/g)].map((newline) => newline.index + 1)];
      const lineOf = (index) => lineStarts.findLastIndex((start) => start <= index) + 1;
      const headsByLine = Map.groupBy(
        [...code.matchAll(STATEMENT_HEAD)].map((head) => head.index),
        (index) => lineOf(index),
      );
      const importedFrom = new Map();
      const readHeads = new Set();
      for (const { specifier, line, kind } of importsIn(text)) {
        const target = kind === "static" ? workspacePackageFor(specifier, names) : undefined;
        if (!target || target === pkg) {
          continue;
        }
        for (const head of headsByLine.get(line) ?? []) {
          if (readHeads.has(head)) {
            continue;
          }
          const statement = HEAD_TO_FROM.exec(code.slice(head));
          const open = statement ? head + statement[0].length - 1 : -1;
          if (!statement || text.slice(open + 1, text.indexOf(text[open], open + 1)) !== specifier) {
            continue;
          }
          const [, keyword, clause] = statement;
          if (keyword === "export") {
            const braces = /^\{([^}]*)\}$/.exec(clause);
            const passed = braces ? clauseEntries(braces[1]) : [clause.replace(/\s+/g, " ")];
            violations.push(`${displayPath(file)}:${line} re-exports ${passed.join(", ")} from ${specifier}`);
          } else {
            for (const binding of importedBindings(clause)) {
              importedFrom.set(binding, specifier);
            }
          }
          readHeads.add(head);
          break;
        }
      }
      for (const match of code.matchAll(LOCAL_EXPORT_CLAUSE)) {
        const passedBySpecifier = Map.groupBy(
          clauseEntries(match[1]).filter((entry) => importedFrom.has(entry.split(" as ")[0])),
          (entry) => importedFrom.get(entry.split(" as ")[0]),
        );
        for (const [specifier, passed] of passedBySpecifier) {
          violations.push(
            `${displayPath(file)}:${lineOf(match.index)} re-exports ${passed.join(", ")} from ${specifier}`,
          );
        }
      }
    }
  }
  return violations;
}

function layeredGraphComment() {
  const rows = [...LAYERS.entries()].map(
    ([name, layers]) => `${name} in the order ${layers.map((names) => names.join("|")).join(", ")}`,
  );
  return `a package directory imports only from its own directory or one below it, per its row in LAYERS: ${rows.join("; ")}.`;
}

const packages = await discoverPackages();
const packagesByName = new Map(packages.filter((pkg) => pkg.manifest?.name).map((pkg) => [pkg.manifest.name, pkg]));

const rules = [
  {
    name: "every-package-has-a-role",
    comment:
      "every directory under packages/ that holds a package.json or source a scan reads names a role in scripts/package-roles.mjs, or the check that reads it cannot see it; a directory holding neither — a retired package's ignored build output — is no package.",
    check: async () => everyPackageHasARole(packages),
  },
  {
    name: "imports-are-declared",
    comment:
      "a file under a package's src/ imports only its own package, the platform's own modules, and the packages its dependencies or peerDependencies declare, third-party and workspace alike; any other file may also import its devDependencies, and — the root links it for every package's tests — @musai/test-support undeclared.",
    check: async () => importsAreDeclared(packages, packagesByName),
  },
  {
    name: "relative-imports-stay-in-their-package",
    comment:
      "a file reaches another package only by the name its manifest declares, never by a relative path that climbs out of its own package's directory.",
    check: async () => relativeImportsStayInTheirPackage(packages),
  },
  {
    name: "declared-graph-is-acyclic",
    comment:
      "pnpm sequences a recursive build over dependencies, peerDependencies, devDependencies and optionalDependencies together, so a cycle through any of them breaks it.",
    check: async () => declaredGraphIsAcyclic(packages, packagesByName),
  },
  {
    name: "excluded-edges-stay-undeclared",
    comment:
      "a package never declares, in dependencies, peerDependencies, devDependencies or optionalDependencies, a package its row in EXCLUDED in scripts/package-roles.mjs names, so none of its files, a test's included, may import one.",
    check: async () => excludedEdgesStayUndeclared(packages, packagesByName),
  },
  {
    name: "kernel-side-reaches-no-distribution-or-surface",
    comment:
      "a kernel-side package is the foundation every distribution and surface builds on — it never declares or imports one back.",
    check: async () => reachesInto(packages, packagesByName, "kernel-side", new Set(["distribution", "surface"])),
  },
  {
    name: "surfaces-reach-no-distribution",
    comment:
      "a surface is generic over the distribution it is handed, and the binding that hands it one lives in the distribution — a surface never declares or imports one.",
    check: async () => reachesInto(packages, packagesByName, "surface", new Set(["distribution"])),
  },
  {
    name: "never-shipped-packages-stay-undeclared",
    comment:
      "a kernel-side package, a surface or a distribution ships, and a test helper, a scenario or musai's content never does — nothing that ships declares one in dependencies, peerDependencies, devDependencies or optionalDependencies; the root links the helper for every package's tests.",
    check: async () => neverShippedPackagesStayUndeclared(packages, packagesByName),
  },
  {
    name: "surfaces-declare-only-the-kernel-side-packages-they-import",
    comment:
      "a surface is generic over the distribution it is handed and reaches kernel-side packages directly, so its dependencies and peerDependencies hold a kernel-side package only where its own src/ imports it — @musai/api-core, whose registry and runHandler it projects, and what else its source names; a package only its tests need is a devDependency.",
    check: async () => surfacesDeclareOnlyTheKernelSidePackagesTheyImport(packages, packagesByName),
  },
  {
    name: "scenarios-reach-the-kernel-only-by-spawning-it",
    comment:
      "a scenario reaches the kernel only by spawning the built binary — never by importing a kernel-side package directly.",
    check: async () => scenariosReachTheKernelOnlyBySpawningIt(packages, packagesByName),
  },
  {
    name: "type-only-edges-carry-only-types",
    comment:
      "a package imports what TYPE_ONLY in scripts/package-roles.mjs holds it to only through a statement-level `import type` or `export type`, which loads nothing at runtime; `import { type X }` still loads the module.",
    check: async () => typeOnlyEdgesCarryOnlyTypes(packages, packagesByName),
  },
  {
    name: "barrels-carry-only-their-own-names",
    comment:
      "a kernel-side package or a surface exports only names it defines, so a consumer imports each name from its one home — no file under its src/ re-exports from another workspace package or exports a binding it imported from one; a third-party re-export passes, and a distribution is on nobody's import list.",
    check: async () => barrelsCarryOnlyTheirOwnNames(packages, packagesByName),
  },
  {
    name: "directories-form-one-layered-graph",
    comment: layeredGraphComment(),
    check: async () => directoriesFormOneLayeredGraph(packages),
  },
];

let failed = false;
for (const rule of rules) {
  const violations = await rule.check();
  if (violations.length > 0) {
    failed = true;
    console.error(`error ${rule.name}: ${rule.comment}`);
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("no dependency violations found");
