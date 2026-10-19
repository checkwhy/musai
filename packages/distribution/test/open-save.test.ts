import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, runHandler } from "@musai/api-core";
import type { ModuleArtefacts } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import {
  type ArtifactRecord,
  CURRENT_SCHEMA_VERSIONS,
  type ModuleRecord,
  type RecordId,
  recordId,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { caseBook } from "../src/ops/case.js";
import { caseOpen } from "../src/ops/open.js";
import { caseSave } from "../src/ops/save.js";

const MODULE_NAME = "template-fixture";
const PRESET_CONTRIBUTION_ID = `${MODULE_NAME}/anything`;
const TEMPLATE_CONTRIBUTION_ID = `${PRESET_CONTRIBUTION_ID}/draft`;

/** A draft template embedding an anchor to its case, so a starter draft can be anchored prose. */
function templateSource(): string {
  return [
    "export function invoke(requestBytes) {",
    "  return (async () => {",
    "    const request = JSON.parse(new TextDecoder().decode(requestBytes));",
    "    const caseId = request.input.case;",
    "    const hex = caseId.slice('sha256:'.length, 'sha256:'.length + 12);",
    "    const content = 'Starter prose citing the case.[^' + hex + ']\\n\\n## Receipts\\n\\n[^' + hex + ']: ' + caseId + '\\n';",
    "    const output = { format: 'markdown', content };",
    "    return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));",
    "  })();",
    "}",
  ].join("\n");
}

async function installTemplateModule(workspaceDir: string, store: Store): Promise<void> {
  const bundleId = await blobStoreOf(workspaceDir).put(new TextEncoder().encode(templateSource()));
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: MODULE_NAME,
    version: versionString("1"),
    manifest: {
      protocolVersion: ENVELOPE_PROTOCOL,
      contributions: [
        {
          kind: "template",
          id: TEMPLATE_CONTRIBUTION_ID,
          version: versionString("1"),
          input: true,
          output: true,
          documentation: "renders a case's starter draft",
        },
      ],
      sourceTree: { digest: { gitTree: "a".repeat(40) } },
      toolchain: [{ name: "node", version: versionString("24.0.0") }],
      packages: [],
    },
    bundle: bundleId,
    build: recordId({ marker: "template-fixture-build" }),
  };
  await store.putMany([{ kind: "module", value: moduleRecord }]);
}

describe("case.open@1 and case.save@1", () => {
  let workspace: string;
  let artefacts: ModuleArtefacts;
  const scope = "default";
  const now = fixedClock("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    artefacts = await readDistributionArtefacts();
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-open-save-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx() {
    return { workspace, scope, now };
  }

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
  }

  async function bookBareCase(slug: string) {
    const store = storeAt();
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(artefacts, store, blobStoreOf(workspace), index);
    return runHandler(caseBook, { slug }, ctx());
  }

  async function bookTemplatedCase(slug: string) {
    await installTemplateModule(workspace, storeAt());
    return runHandler(caseBook, { slug, preset: PRESET_CONTRIBUTION_ID }, ctx());
  }

  test("open materialises the worktree and returns its path; run twice at one head returns the same path at the same commit and mints no record", async () => {
    await bookBareCase("open-twice");
    const idsBefore = await storeAt().list("artifact");

    const first = await runHandler(caseOpen, { case: "open-twice" }, ctx());
    const second = await runHandler(caseOpen, { case: "open-twice" }, ctx());

    expect(second.path).toBe(first.path);
    expect(second.commit).toBe(first.commit);
    const idsAfter = await storeAt().list("artifact");
    expect(idsAfter).toEqual(idsBefore);
  });

  test("save with no changed draft mints no artifact record and says so", async () => {
    await bookBareCase("no-change");
    await runHandler(caseOpen, { case: "no-change" }, ctx());

    const output = await runHandler(caseSave, { case: "no-change" }, ctx());

    expect(output.minted).toEqual([]);
    expect(output.refused).toEqual([]);
  });

  test("save with one changed draft mints exactly one artifact record carrying the draft's bytes, its format, and an empty supersedes for a first draft", async () => {
    await bookTemplatedCase("first-draft");
    const opened = await runHandler(caseOpen, { case: "first-draft" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");

    const original = await readFile(draftPath, "utf8");
    expect(original).toContain("Starter prose");

    const edited = original.replace("Starter prose citing the case.", "A person's own words, also citing the case.");
    await writeFile(draftPath, edited);

    const output = await runHandler(caseSave, { case: "first-draft" }, ctx());

    expect(output.minted).toHaveLength(1);
    const minted = output.minted[0]!.record as ArtifactRecord;
    expect(minted.content).toBe(edited);
    expect(minted.format).toBe("markdown");
    expect(minted.supersedes).toEqual([]);
  });

  test("a repeated save with no edit and no re-open mints nothing, the case already holding that draft", async () => {
    await bookTemplatedCase("saved-twice");
    const opened = await runHandler(caseOpen, { case: "saved-twice" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");
    await writeFile(draftPath, `${await readFile(draftPath, "utf8")}\nOne edit, saved twice.\n`);

    const first = await runHandler(caseSave, { case: "saved-twice" }, ctx());
    const second = await runHandler(caseSave, { case: "saved-twice" }, ctx());

    expect(first.minted).toHaveLength(1);
    expect(second.minted).toEqual([]);
    expect(caseSave.renderText!(second)).toBe("nothing changed");
    expect(await storeAt().list("artifact")).toEqual([first.minted[0]!.id]);
  });

  describe("a save the case already holds a different record for", () => {
    async function editedDraft(slug: string): Promise<{ edited: string; caseId: RecordId }> {
      const booked = await bookTemplatedCase(slug);
      const opened = await runHandler(caseOpen, { case: slug }, ctx());
      const draftPath = join(opened.path, "drafts", "draft.md");
      const edited = `${await readFile(draftPath, "utf8")}\nWords the case may already hold.\n`;
      await writeFile(draftPath, edited);
      return { edited, caseId: booked.case };
    }

    function heldAs(caseId: RecordId, edited: string, changes: Partial<ArtifactRecord>): ArtifactRecord {
      return {
        kind: "artifact",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
        case: caseId,
        lifecycle: "drafted",
        content: edited,
        format: "markdown",
        supersedes: [],
        ...changes,
      };
    }

    test.each([
      ["dropped", { lifecycle: "dropped" as const }],
      ["retracted", { lifecycle: "retracted" as const }],
      ["in another format", { format: "text" }],
    ])("a draft matching a held record %s still mints", async (name, changes) => {
      const { edited, caseId } = await editedDraft(`held-${name.replaceAll(" ", "-")}`);
      await storeAt().putMany([{ kind: "artifact", value: heldAs(caseId, edited, changes) }]);

      const saved = await runHandler(caseSave, { case: `held-${name.replaceAll(" ", "-")}` }, ctx());

      expect(saved.minted).toHaveLength(1);
      expect(saved.minted[0]!.record).toMatchObject({ lifecycle: "drafted", content: edited, format: "markdown" });
    });

    test("an unsalted save of a draft the case holds only salted still mints", async () => {
      await editedDraft("held-salted");
      const salted = await runHandler(caseSave, { case: "held-salted", salt: true }, ctx());

      const plain = await runHandler(caseSave, { case: "held-salted" }, ctx());

      expect(salted.minted).toHaveLength(1);
      expect(plain.minted).toHaveLength(1);
      expect(plain.minted[0]!.id).not.toBe(salted.minted[0]!.id);
    });
  });

  test("save with a salt mints a salted artifact carrying the draft's bytes", async () => {
    await bookTemplatedCase("salted-draft");
    const opened = await runHandler(caseOpen, { case: "salted-draft" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");
    const edited = (await readFile(draftPath, "utf8")).replace("Starter prose citing the case.", "Words to hide.");
    await writeFile(draftPath, edited);

    const output = await runHandler(caseSave, { case: "salted-draft", salt: true }, ctx());

    expect(output.minted).toHaveLength(1);
    expect(output.minted[0]!.record).toMatchObject({
      content: edited,
      salt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("save with two changed drafts (across two saves, re-opening between them) mints two artifact records, one per draft, each naming what it was edited from", async () => {
    await bookTemplatedCase("two-drafts");
    const opened = await runHandler(caseOpen, { case: "two-drafts" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");
    const original = await readFile(draftPath, "utf8");

    await writeFile(draftPath, `${original}\nMore prose from the same lane.\n`);
    const firstSave = await runHandler(caseSave, { case: "two-drafts" }, ctx());
    expect(firstSave.minted).toHaveLength(1);
    const firstArtifactId = firstSave.minted[0]!.id;

    // Re-open so the new head renders under its own path, then save a second change.
    const reopened = await runHandler(caseOpen, { case: "two-drafts" }, ctx());
    const secondDraftPath = join(
      reopened.path,
      "drafts",
      `${firstArtifactId.slice("sha256:".length, "sha256:".length + 12)}.md`,
    );
    const secondBaseline = await readFile(secondDraftPath, "utf8");
    await writeFile(secondDraftPath, `${secondBaseline}\nA second, later edit.\n`);

    const secondSave = await runHandler(caseSave, { case: "two-drafts" }, ctx());
    expect(secondSave.minted).toHaveLength(1);
    const secondArtifact = secondSave.minted[0]!.record as ArtifactRecord;
    expect(secondArtifact.supersedes).toEqual([firstArtifactId]);
  });

  test("a modified derived file is refused by name and nothing is minted for it; a changed draft in the same save still mints", async () => {
    await bookTemplatedCase("derived-and-draft");
    const opened = await runHandler(caseOpen, { case: "derived-and-draft" }, ctx());

    const dossierPath = join(opened.path, "dossier.md");
    const dossierBefore = await readFile(dossierPath, "utf8");
    // A hand can override the mode bits, so `save`'s refusal is what holds the line.
    await chmod(dossierPath, 0o644);
    await writeFile(dossierPath, `${dossierBefore}\ntampered\n`);

    const draftPath = join(opened.path, "drafts", "draft.md");
    const draftOriginal = await readFile(draftPath, "utf8");
    await writeFile(draftPath, `${draftOriginal}\na real edit\n`);

    const output = await runHandler(caseSave, { case: "derived-and-draft" }, ctx());

    expect(output.refused).toEqual([{ path: "dossier.md", reason: "render-edited", detail: expect.any(String) }]);
    expect(output.minted).toHaveLength(1);

    const dossierAfter = await readFile(dossierPath, "utf8");
    expect(dossierAfter).toBe(`${dossierBefore}\ntampered\n`);
  });

  test("save refuses an anchor whose full id is not in the store, naming the label and the id, and leaves the draft's bytes on disk unchanged", async () => {
    await bookTemplatedCase("bad-anchor");
    const opened = await runHandler(caseOpen, { case: "bad-anchor" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");

    const badAnchor = [
      "A claim resting on nothing real.[^ffffffffffff]",
      "",
      "## Receipts",
      "",
      `[^ffffffffffff]: sha256:${"f".repeat(64)}`,
      "",
    ].join("\n");
    await writeFile(draftPath, badAnchor);

    const output = await runHandler(caseSave, { case: "bad-anchor" }, ctx());

    expect(output.minted).toEqual([]);
    expect(output.refused).toHaveLength(1);
    expect(output.refused[0]!.reason).toBe("no-such-record");
    expect(output.refused[0]!.detail).toContain("ffffffffffff");
    expect(output.refused[0]!.detail).toContain(`sha256:${"f".repeat(64)}`);

    const bytesAfter = await readFile(draftPath, "utf8");
    expect(bytesAfter).toBe(badAnchor);
  });

  test("save does not refuse a sentence with no anchor", async () => {
    await bookTemplatedCase("unanchored-sentence");
    const opened = await runHandler(caseOpen, { case: "unanchored-sentence" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");
    await writeFile(draftPath, "Just a plain sentence nobody anchored to anything.\n");

    const output = await runHandler(caseSave, { case: "unanchored-sentence" }, ctx());

    expect(output.minted).toHaveLength(1);
    expect(output.refused).toEqual([]);
  });

  test("an artifact whose format has no installed grammar saves with no anchors and says so, rather than saving silently", async () => {
    const booked = await bookBareCase("no-grammar");
    const parent: ArtifactRecord = {
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: booked.case,
      lifecycle: "drafted",
      content: "Plain text, no markdown at all.\n",
      format: "plaintext",
      supersedes: [],
    };
    const [parentId] = await storeAt().putMany([{ kind: "artifact", value: parent }]);

    const opened = await runHandler(caseOpen, { case: "no-grammar" }, ctx());
    const draftPath = join(opened.path, "drafts", `${parentId!.slice("sha256:".length, "sha256:".length + 12)}.txt`);
    const original = await readFile(draftPath, "utf8");
    await writeFile(draftPath, `${original}An edit, still plain text.\n`);

    const output = await runHandler(caseSave, { case: "no-grammar" }, ctx());

    expect(output.refused).toEqual([]);
    expect(output.minted).toHaveLength(1);
    expect(output.warnings).toEqual([
      { path: expect.any(String), reason: "unsupported-format", detail: expect.any(String) },
    ]);
    const minted = output.minted[0]!.record as ArtifactRecord;
    expect(minted.format).toBe("plaintext");
    expect(minted.supersedes).toEqual([parentId]);
  });

  test("anchors are derived from the saved content at fold: the index's mapping for an artifact comes from parsing its receipts section, with no anchor field on the record", async () => {
    await bookTemplatedCase("indexed-anchors");
    const opened = await runHandler(caseOpen, { case: "indexed-anchors" }, ctx());
    const draftPath = join(opened.path, "drafts", "draft.md");
    const original = await readFile(draftPath, "utf8");
    await writeFile(draftPath, original);
    await writeFile(draftPath, `${original}\nchanged\n`);

    const saved = await runHandler(caseSave, { case: "indexed-anchors" }, ctx());
    expect(saved.minted).toHaveLength(1);
    const artifactId = saved.minted[0]!.id;
    const record = saved.minted[0]!.record as ArtifactRecord;
    expect(Object.keys(record)).not.toContain("anchors");

    const reopened = await openWorkspace({ workspace, scope, now });
    const anchors = reopened.index.anchorsOf(artifactId);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]!.fullId.startsWith("sha256:")).toBe(true);
  });

  test("two saves of one draft from two lanes fork into two artifact records both naming the same single parent, both visible in the dossier; a later draft naming both closes the fork", async () => {
    const booked = await bookBareCase("fork");
    const caseId = booked.case;

    const parent: ArtifactRecord = {
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: caseId,
      lifecycle: "drafted",
      content: "The parent draft, before either lane touched it.\n",
      format: "markdown",
      supersedes: [],
    };
    const [parentId] = await storeAt().putMany([{ kind: "artifact", value: parent }]);

    const opened = await runHandler(caseOpen, { case: "fork" }, ctx());
    const draftPath = join(opened.path, "drafts", `${parentId!.slice("sha256:".length, "sha256:".length + 12)}.md`);
    const baseline = await readFile(draftPath, "utf8");
    expect(baseline).toBe(parent.content);

    await writeFile(draftPath, `${baseline}first lane's edit\n`);
    const laneOne = await runHandler(caseSave, { case: "fork" }, ctx());
    expect(laneOne.minted).toHaveLength(1);

    // The worktree is not rebuilt, so the second lane diffs against the shared parent too.
    await writeFile(draftPath, `${baseline}second lane's edit\n`);
    const laneTwo = await runHandler(caseSave, { case: "fork" }, ctx());
    expect(laneTwo.minted).toHaveLength(1);

    const childOne = laneOne.minted[0]!.record as ArtifactRecord;
    const childTwo = laneTwo.minted[0]!.record as ArtifactRecord;
    expect(childOne.supersedes).toEqual([parentId]);
    expect(childTwo.supersedes).toEqual([parentId]);
    expect(laneOne.minted[0]!.id).not.toBe(laneTwo.minted[0]!.id);

    const forkedOpen = await runHandler(caseOpen, { case: "fork" }, ctx());
    expect(forkedOpen.files.filter((path) => path.startsWith("drafts/"))).toHaveLength(2);

    // A later draft superseding both forks closes the fork to one head.
    const closing: ArtifactRecord = {
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: caseId,
      lifecycle: "drafted",
      content: "The reconciled draft.\n",
      format: "markdown",
      supersedes: [laneOne.minted[0]!.id, laneTwo.minted[0]!.id],
    };
    await storeAt().putMany([{ kind: "artifact", value: closing }]);

    const closedOpen = await runHandler(caseOpen, { case: "fork" }, ctx());
    expect(closedOpen.files.filter((path) => path.startsWith("drafts/"))).toHaveLength(1);
  });
});
