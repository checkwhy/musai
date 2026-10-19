import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { KernelError } from "@musai/records";
import { insideCheckout } from "@musai/run";
import { PackageURL } from "packageurl-js";
import type { EsbuildMetafile } from "./metafile.js";

/** Raised when a file drawn as a package's yields no versioned package url. A blank version would
 * fail only once a receiver's own tooling reads it. */
export class PurlDerivationError extends KernelError {
  constructor(message: string) {
    super({ reason: "workspace-incomplete", detail: message });
    this.name = "PurlDerivationError";
  }
}

/** A key carries an import's `?` or `#` suffix verbatim, and a suffix's `..` names no directory. */
function inputFilePath(inputKey: string): string {
  const suffixStart = inputKey.search(/[?#]/);
  return suffixStart === -1 ? inputKey : inputKey.slice(0, suffixStart);
}

/** A data URL's key names no file: its bytes are its importer's text. */
function namesDataUrl(inputKey: string): boolean {
  return inputKey.startsWith("<data:");
}

/** A subpath import (`#`) or a URL reaches a file by where it sits, not by whose it is. */
function namesPackage(specifier: string): boolean {
  return !/^[./\\#]/.test(specifier) && !specifier.includes(":");
}

/** Whose each file of a bundle is, as the build metadata keys them, each list sorted. */
export interface BundleOwners {
  /** Its entry, what that reaches through paths alone, and every input no import reaches. */
  readonly own: readonly string[];
  /** Files reached through a specifier naming a package, and what those draw in turn. */
  readonly packaged: readonly string[];
}

/** A file reached both ways is in both lists. */
export function bundleOwners(metafile: EsbuildMetafile, entryKey: string): BundleOwners {
  const own = new Set<string>();
  const packaged = new Set<string>();
  const pending = [{ key: entryKey, packaged: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const reached = next.packaged ? packaged : own;
    if (reached.has(next.key)) {
      continue;
    }
    reached.add(next.key);
    for (const imported of metafile.inputs[next.key]!.imports) {
      // esbuild keys no input for an external import, nor for one it dropped as unused.
      if (Object.hasOwn(metafile.inputs, imported.path)) {
        const byName = imported.original !== undefined && namesPackage(imported.original);
        pending.push({ key: imported.path, packaged: next.packaged || byName });
      }
    }
  }
  // An input no import reaches, as a pattern import's match, is held to be the module's own.
  for (const key of Object.keys(metafile.inputs)) {
    if (!packaged.has(key)) {
      own.add(key);
    }
  }
  return { own: [...own].sort(), packaged: [...packaged].sort() };
}

/** Keys are real paths relative to the module's real directory, so an outward symlink is keyed by
 * its target, and a sibling whose name begins with the module's lies outside. */
export function outsideModuleDirectory(ownKeys: readonly string[]): string[] {
  return ownKeys.filter((key) => !namesDataUrl(key) && !insideCheckout(inputFilePath(key))).sort();
}

interface NamingManifest {
  readonly path: string;
  readonly name: string;
  readonly version: string | undefined;
}

/** A `package.json` naming no package is passed over, as is a path through a PnP archive file. */
function namingManifestAt(
  dir: string,
  read: Map<string, Promise<NamingManifest | undefined>>,
): Promise<NamingManifest | undefined> {
  let manifest = read.get(dir);
  if (manifest === undefined) {
    manifest = readNamingManifest(dir, read);
    read.set(dir, manifest);
  }
  return manifest;
}

async function readNamingManifest(
  dir: string,
  read: Map<string, Promise<NamingManifest | undefined>>,
): Promise<NamingManifest | undefined> {
  const path = join(dir, "package.json");
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
  }
  if (text !== undefined) {
    const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      const version = typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined;
      return { path, name: parsed.name, version };
    }
  }
  const parent = dirname(dir);
  return parent === dir ? undefined : namingManifestAt(parent, read);
}

function purlFor(packageName: string, version: string): string {
  const slash = packageName.indexOf("/");
  const scoped = packageName.startsWith("@") && slash !== -1;
  const namespace = scoped ? packageName.slice(0, slash) : undefined;
  const name = scoped ? packageName.slice(slash + 1) : packageName;
  return new PackageURL("npm", namespace, name, version, undefined, undefined).toString();
}

/** Where a bundle's files came from: what its build refuses, and what its manifest records. */
export interface BundleProvenance {
  /** The module's own files outside its directory, as the build metadata keys them. */
  readonly outsideDirectory: readonly string[];
  /** The package url of each package the bundle drew a file from, sorted. */
  readonly packages: readonly string[];
}

/** A file reached by path is the module's own, and one reached by package name is recorded by the
 * package url of its nearest naming `package.json`, unless that package holds the module. */
export async function bundleProvenance(
  metafile: EsbuildMetafile,
  entryKey: string,
  moduleDir: string,
): Promise<BundleProvenance> {
  const { own, packaged } = bundleOwners(metafile, entryKey);
  const read = new Map<string, Promise<NamingManifest | undefined>>();
  const heldByModule: string[] = [];
  const purlsByManifest = new Map<string, string>();
  for (const key of packaged) {
    if (namesDataUrl(key)) {
      continue;
    }
    const manifest = await namingManifestAt(dirname(resolve(moduleDir, inputFilePath(key))), read);
    if (manifest === undefined) {
      throw new PurlDerivationError(
        `refusing to derive a package url for ${key}: no package.json above it names a package`,
      );
    }
    if (insideCheckout(relative(dirname(manifest.path), moduleDir))) {
      heldByModule.push(key);
    } else if (manifest.version === undefined) {
      throw new PurlDerivationError(
        `refusing to derive a package url for ${key}: its package.json, ${relative(moduleDir, manifest.path).replaceAll(sep, "/")}, names ${manifest.name} and no version`,
      );
    } else {
      purlsByManifest.set(manifest.path, purlFor(manifest.name, manifest.version));
    }
  }
  return {
    outsideDirectory: outsideModuleDirectory([...new Set([...own, ...heldByModule])]),
    packages: [...new Set(purlsByManifest.values())].sort(),
  };
}
