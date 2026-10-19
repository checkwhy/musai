import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Workspace } from "@musai/api-core";
import { installedManifests, invokeContribution } from "@musai/api-core";
import type { ContributionEntry } from "@musai/records";

const SKILLS_SUBDIR = "skills";

const SKILL_FILE_NAME = "SKILL.md";

/** Marks a directory a sync wrote, telling it apart from a skill the plugin ships by hand. */
const OWNER_MARKER_NAME = ".musai-module";

/** Raised when a module's skill name resolves outside the plugin's skills directory. A module's
 * path is untrusted: a traversal would let it write anywhere the user can. */
export class SkillPathEscapeError extends Error {
  constructor(moduleName: string, targetPath: string) {
    super(`refusing to sync ${moduleName}'s own skill: ${targetPath} escapes the plugin's own skills directory`);
    this.name = "SkillPathEscapeError";
  }
}

/** What one sync did: skills written, removed because no module claims them, and unchanged. */
export interface SyncSkillsResult {
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

interface MarkedSkill {
  readonly moduleName: string;
  readonly entry: ContributionEntry;
  readonly name: string;
}

/** Every installed module's marked skill, sorted by name so two reads at one head are equal. */
function markedSkillsFrom(
  manifests: readonly {
    readonly moduleName: string;
    readonly manifest: { readonly contributions: readonly ContributionEntry[] };
  }[],
): readonly MarkedSkill[] {
  const marked: MarkedSkill[] = [];
  for (const named of manifests) {
    for (const entry of named.manifest.contributions) {
      if (entry.kind === "template" && entry.skill !== undefined) {
        marked.push({ moduleName: named.moduleName, entry, name: entry.skill.name });
      }
    }
  }
  return marked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function resolvedSkillDir(skillsDir: string, skill: MarkedSkill): string {
  const boundary = resolve(skillsDir) + sep;
  const resolved = resolve(skillsDir, skill.name);
  if (!resolved.startsWith(boundary)) {
    throw new SkillPathEscapeError(skill.moduleName, resolved);
  }
  return resolved;
}

/** Writes through a temporary name and a rename, so a session never loads a fragment. */
async function writeAtomically(dir: string, fileName: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tempName = `.tmp-${randomBytes(8).toString("hex")}`;
  const tempPath = join(dir, tempName);
  await writeFile(tempPath, bytes);
  await rename(tempPath, join(dir, fileName));
}

async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** The skill directories an earlier sync wrote; a hand-shipped skill carries no marker. */
async function previouslySyncedNames(skillsDir: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const owned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const marker = await readIfPresent(join(skillsDir, entry.name, OWNER_MARKER_NAME));
    if (marker !== undefined) {
      owned.push(entry.name);
    }
  }
  return owned;
}

/** A marked skill's bytes, rendered with no input: a plugin skill is a static file. */
async function renderSkillContent(opened: Workspace, skill: MarkedSkill): Promise<Uint8Array> {
  const response = await invokeContribution(opened, skill.moduleName, skill.entry, {});
  if (!response.ok) {
    throw new Error(
      `refusing to sync ${skill.moduleName}'s own skill ${skill.name}: ${JSON.stringify(response.error)}`,
    );
  }
  const output = response.output as { readonly content?: unknown } | null;
  const content =
    output !== null && typeof output.content === "string" ? output.content : JSON.stringify(response.output);
  return new TextEncoder().encode(content);
}

/** Writes every installed module's marked skill into the plugin, removing ones no module claims
 * and leaving hand-shipped skills alone. A local write: it mints no record. */
export async function syncSkills(opened: Workspace, pluginDir: string): Promise<SyncSkillsResult> {
  const skillsDir = join(pluginDir, SKILLS_SUBDIR);

  const manifests = await installedManifests(opened);
  const marked = markedSkillsFrom(manifests);

  // Every target is resolved first, so one bad module refuses the whole sync.
  const resolved = marked.map((skill) => ({ skill, dir: resolvedSkillDir(skillsDir, skill) }));

  const previousNames = await previouslySyncedNames(skillsDir);
  const desiredNames = new Set(resolved.map(({ skill }) => skill.name));

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const { skill, dir } of resolved) {
    const content = await renderSkillContent(opened, skill);
    const existing = await readIfPresent(join(dir, SKILL_FILE_NAME));
    if (existing !== undefined && Buffer.compare(existing, Buffer.from(content)) === 0) {
      unchanged.push(skill.name);
      continue;
    }
    await writeAtomically(dir, SKILL_FILE_NAME, content);
    await writeAtomically(dir, OWNER_MARKER_NAME, new TextEncoder().encode(skill.moduleName));
    written.push(skill.name);
  }

  const removed: string[] = [];
  for (const name of previousNames) {
    if (!desiredNames.has(name)) {
      await rm(join(skillsDir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }

  return { written: written.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}

export function defaultPluginDir(workspace: string): string {
  return join(workspace, "plugin");
}
