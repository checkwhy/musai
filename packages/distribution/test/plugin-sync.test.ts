import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock, foldedIndex } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultPluginDir, SkillPathEscapeError, syncSkills } from "../src/plugin/sync.js";
import { repoGitDir } from "./repo-git-dir.js";

const SKILLFUL_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/skillful", import.meta.url));
const SKILLFUL_ESCAPE_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/skillful-escape", import.meta.url));
const QUIET_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/quiet", import.meta.url));

/** Writes a module carrying one marked skill with `content`, so one name can be built twice. */
async function writeAdHocModule(dir: string, moduleName: string, skillName: string, content: string): Promise<void> {
  const templateId = `${moduleName}/entry`;
  const source = `
interface EnvelopeRequest { readonly protocol: number; readonly contribution: string; readonly id: string; readonly version: string; readonly input: unknown; }
interface ContributionEntry { readonly kind: string; readonly id: string; readonly version: string; readonly input: unknown; readonly output: unknown; readonly documentation: string; readonly skill?: { readonly name: string }; }
const TEMPLATE_ID = ${JSON.stringify(templateId)};
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "template",
    id: TEMPLATE_ID,
    version: "1",
    input: { type: "object", additionalProperties: false, properties: {} },
    output: { type: "object", additionalProperties: false, required: ["format", "content"], properties: { format: { type: "string" }, content: { type: "string" } } },
    documentation: "an ad-hoc module's own marked skill",
    skill: { name: ${JSON.stringify(skillName)} },
  },
];
function respond(output: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }
function respondError(code: string, data: unknown, message: string): Uint8Array { return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } })); }
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as EnvelopeRequest;
  if (request.contribution === "describe") { return respond(CONTRIBUTIONS); }
  if (request.contribution === "template" && request.id === TEMPLATE_ID) { return respond({ format: "text", content: ${JSON.stringify(content)} }); }
  return respondError("unknown-contribution", { id: request.id, contribution: request.contribution }, request.id + " names a contribution this module does not answer");
}
`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: moduleName, version: "0.1.0", private: true, type: "module" }),
  );
  await writeFile(join(dir, "module.ts"), source);
  await execa("git", ["init", "--quiet"], { cwd: dir });
}

describe("syncSkills", () => {
  let workspace: string;
  let pluginDir: string;
  const scope = "default";
  const now = fixedClock("2026-08-31T00:00:00.000Z");

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-plugin-sync-"));
    await initWorkspace(workspace, { now });
    pluginDir = defaultPluginDir(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
  }

  async function view() {
    return openWorkspace({ workspace, scope, now });
  }

  async function installSkillful(): Promise<void> {
    const sourceGitDir = await repoGitDir();
    await buildModule(SKILLFUL_FIXTURE_DIR, storeAt(), {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(storeAt()),
      sourceGitDir,
      now,
    });
  }

  async function installQuiet(): Promise<void> {
    const sourceGitDir = await repoGitDir();
    await buildModule(QUIET_FIXTURE_DIR, storeAt(), {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(storeAt()),
      sourceGitDir,
      now,
    });
  }

  async function installSkillfulEscape(): Promise<void> {
    const sourceGitDir = await repoGitDir();
    await buildModule(SKILLFUL_ESCAPE_FIXTURE_DIR, storeAt(), {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(storeAt()),
      sourceGitDir,
      now,
    });
  }

  test("a marked skill contribution's own rendered content is written into the plugin's skills directory", async () => {
    await installSkillful();
    const result = await syncSkills(await view(), pluginDir);

    expect(result.written).toEqual(["musai-skillful"]);
    expect(result.unchanged).toEqual([]);
    const written = await readFile(join(pluginDir, "skills", "musai-skillful", "SKILL.md"), "utf8");
    expect(written).toBe("skillful's own conversational entry, rendered for real.");
  });

  test("a module declaring no marked skill contributes nothing, and the sync reports no change", async () => {
    await installQuiet();
    const result = await syncSkills(await view(), pluginDir);
    expect(result).toEqual({ written: [], removed: [], unchanged: [] });
  });

  test("a workspace with nothing installed at all syncs to nothing", async () => {
    const result = await syncSkills(await view(), pluginDir);
    expect(result).toEqual({ written: [], removed: [], unchanged: [] });
  });

  test("running sync twice writes byte-identical files, and the second run reports no change", async () => {
    await installSkillful();
    const first = await syncSkills(await view(), pluginDir);
    expect(first.written).toEqual(["musai-skillful"]);

    const before = await readFile(join(pluginDir, "skills", "musai-skillful", "SKILL.md"));
    const second = await syncSkills(await view(), pluginDir);
    const after = await readFile(join(pluginDir, "skills", "musai-skillful", "SKILL.md"));

    expect(second).toEqual({ written: [], removed: [], unchanged: ["musai-skillful"] });
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test("a module whose own declared skill name escapes the plugin's skills directory is refused by name, and nothing is written", async () => {
    await installSkillful();
    await installSkillfulEscape();
    await expect(syncSkills(await view(), pluginDir)).rejects.toBeInstanceOf(SkillPathEscapeError);

    // One bad target refuses the whole sync, the well-behaved sibling's skill included.
    await expect(readFile(join(pluginDir, "skills", "musai-skillful", "SKILL.md"))).rejects.toThrow();
    await expect(readFile(join(pluginDir, "escape-attempt", "SKILL.md"))).rejects.toThrow();
  });

  test("an updated module's skill overwrites the previously synced one", async () => {
    const moduleDir = await mkdtemp(join(tmpdir(), "musai-plugin-sync-module-"));
    try {
      await writeAdHocModule(moduleDir, "updatable", "musai-updatable", "the first version's own words.");
      await buildModule(moduleDir, storeAt(), {
        blobs: blobStoreOf(workspace),
        index: await foldedIndex(storeAt()),
        now,
      });
      const first = await syncSkills(await view(), pluginDir);
      expect(first.written).toEqual(["musai-updatable"]);

      await writeAdHocModule(
        moduleDir,
        "updatable",
        "musai-updatable",
        "the second version's own words, replacing the first.",
      );
      await buildModule(moduleDir, storeAt(), {
        blobs: blobStoreOf(workspace),
        index: await foldedIndex(storeAt()),
        now: fixedClock("2026-08-31T00:01:00.000Z"),
      });
      const second = await syncSkills(await view(), pluginDir);
      expect(second.written).toEqual(["musai-updatable"]);
      const overwritten = await readFile(join(pluginDir, "skills", "musai-updatable", "SKILL.md"), "utf8");
      expect(overwritten).toBe("the second version's own words, replacing the first.");
    } finally {
      await rm(moduleDir, { recursive: true, force: true });
    }
  });

  test("a skill whose module no longer appears among what's installed is removed, and a hand-shipped skill beside it is left alone", async () => {
    const handWrittenDir = join(pluginDir, "skills", "musai-gates");
    await mkdir(handWrittenDir, { recursive: true });
    await writeFile(join(handWrittenDir, "SKILL.md"), "the plugin's own hand-written skill, never a sync's to remove.");

    const moduleDir = await mkdtemp(join(tmpdir(), "musai-plugin-sync-vanishing-module-"));
    let elsewhere: string | undefined;
    try {
      await writeAdHocModule(moduleDir, "vanishing", "musai-vanishing", "here today.");
      await buildModule(moduleDir, storeAt(), {
        blobs: blobStoreOf(workspace),
        index: await foldedIndex(storeAt()),
        now,
      });
      const synced = await syncSkills(await view(), pluginDir);
      expect(synced.written).toEqual(["musai-vanishing"]);
      await expect(readFile(join(pluginDir, "skills", "musai-vanishing", "SKILL.md"))).resolves.toBeDefined();

      // A workspace with nothing installed, synced to the same plugin, stands in for an uninstall.
      elsewhere = await mkdtemp(join(tmpdir(), "musai-plugin-sync-elsewhere-"));
      await initWorkspace(elsewhere, { now });
      const bare = await openWorkspace({ workspace: elsewhere, scope, now });
      const result = await syncSkills(bare, pluginDir);

      expect(result.removed).toEqual(["musai-vanishing"]);
      await expect(readFile(join(pluginDir, "skills", "musai-vanishing", "SKILL.md"))).rejects.toThrow();
    } finally {
      await rm(moduleDir, { recursive: true, force: true });
      if (elsewhere !== undefined) {
        await rm(elsewhere, { recursive: true, force: true });
      }
    }

    const stillThere = await readFile(join(handWrittenDir, "SKILL.md"), "utf8");
    expect(stillThere).toBe("the plugin's own hand-written skill, never a sync's to remove.");
  });

  test("a skill file the plugin ships by hand — carrying no owner marker a sync ever wrote — is left alone", async () => {
    const handWrittenDir = join(pluginDir, "skills", "musai-status");
    await mkdir(handWrittenDir, { recursive: true });
    await writeFile(join(handWrittenDir, "SKILL.md"), "the plugin's own hand-written skill.");

    await installQuiet();
    const result = await syncSkills(await view(), pluginDir);
    expect(result).toEqual({ written: [], removed: [], unchanged: [] });

    const stillThere = await readFile(join(handWrittenDir, "SKILL.md"), "utf8");
    expect(stillThere).toBe("the plugin's own hand-written skill.");
  });

  test("syncing mints no record: the store's own tip commit is unchanged", async () => {
    await installQuiet();
    const store = storeAt();
    const before = await store.tip();
    await syncSkills(await view(), pluginDir);
    const after = await store.tip();
    expect(after).toBe(before);
  });

  test("plugin.sync writes through a temporary name and a rename, leaving no stray temporary file behind a successful sync", async () => {
    await installQuiet();
    const moduleDir = await mkdtemp(join(tmpdir(), "musai-plugin-sync-atomic-"));
    try {
      await writeAdHocModule(moduleDir, "atomic", "musai-atomic", "written through a temp name and a rename.");
      await buildModule(moduleDir, storeAt(), {
        blobs: blobStoreOf(workspace),
        index: await foldedIndex(storeAt()),
        now,
      });
      await syncSkills(await view(), pluginDir);

      const entries = await readdir(join(pluginDir, "skills", "musai-atomic"));
      expect(entries.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
      expect(entries).toContain("SKILL.md");
    } finally {
      await rm(moduleDir, { recursive: true, force: true });
    }
  });
});
