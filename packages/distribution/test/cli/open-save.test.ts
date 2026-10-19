import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IndexDb } from "@musai/fold";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { CURRENT_SCHEMA_VERSIONS, type ModuleRecord, recordId, versionString } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { blobStoreOf, fixedClock, SCENARIO_INSTANT } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const now = fixedClock(SCENARIO_INSTANT);

const MODULE_NAME = "cli-template-fixture";
const PRESET_CONTRIBUTION_ID = `${MODULE_NAME}/anything`;
const TEMPLATE_CONTRIBUTION_ID = `${PRESET_CONTRIBUTION_ID}/draft`;

/** The starter-draft template `open-save.test.ts` uses: a draft anchored to its case. */
function templateSource(): string {
  return [
    "export function invoke(requestBytes) {",
    "  return (async () => {",
    "    const request = JSON.parse(new TextDecoder().decode(requestBytes));",
    "    const caseId = request.input.case;",
    "    const hex = caseId.slice('sha256:'.length, 'sha256:'.length + 12);",
    "    const content = 'Filed against the case itself.[^' + hex + ']\\n\\n## Receipts\\n\\n[^' + hex + ']: ' + caseId + '\\n';",
    "    const output = { format: 'markdown', content };",
    "    return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));",
    "  })();",
    "}",
  ].join("\n");
}

describe("open, hand-edit, save — against the built binary", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-open-save-"));
    await execa("node", [CLI_PATH, "init", workspace]);

    const store = new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: "default", now });
    const bundleId = await blobStoreOf(workspace).put(new TextEncoder().encode(templateSource()));
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
            documentation: "renders the CLI e2e case's starter draft",
          },
        ],
        sourceTree: { digest: { gitTree: "a".repeat(40) } },
        toolchain: [{ name: "node", version: versionString("24.0.0") }],
        packages: [],
      },
      bundle: bundleId,
      build: recordId({ marker: "cli-template-fixture-build" }),
    };
    await store.putMany([{ kind: "module", value: moduleRecord }]);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("open then hand-edit then save mints a new artifact whose anchor resolves back to the case", async () => {
    await execa("node", [
      CLI_PATH,
      "lab",

      "book",
      "cli-open-save-case",
      "--preset",
      PRESET_CONTRIBUTION_ID,
      "--workspace",
      workspace,
    ]);

    const openOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "open",
      "cli-open-save-case",
      "--workspace",
      workspace,
      "--json",
    ]);
    const opened = JSON.parse(openOutput.stdout) as { path: string; commit: string; files: string[] };
    expect(opened.files).toContain("drafts/draft.md");

    const draftPath = join(opened.path, "drafts", "draft.md");
    const starter = await readFile(draftPath, "utf8");
    expect(starter).toContain("Filed against the case itself.");

    const edited = starter.replace(
      "Filed against the case itself.",
      "A person's own words, filed against the case itself.",
    );
    await writeFile(draftPath, edited);

    const saveOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "save",
      "cli-open-save-case",
      "--workspace",
      workspace,
      "--json",
    ]);
    const saved = JSON.parse(saveOutput.stdout) as {
      minted: Array<{ id: string; kind: string; record: { content: string; format: string; supersedes: string[] } }>;
      refused: unknown[];
    };

    expect(saved.refused).toEqual([]);
    expect(saved.minted).toHaveLength(1);
    const artifact = saved.minted[0]!;
    expect(artifact.record.content).toBe(edited);
    expect(artifact.record.supersedes).toEqual([]);

    // The anchor resolves from the artifact's bytes; a fold of this check's own reads it in memory.
    const index = new IndexDb();
    await index.fold(new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: "default", now }));
    const anchors = index.anchorsOf(artifact.id as `sha256:${string}`);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.fullId.startsWith("sha256:")).toBe(true);
  });
});
