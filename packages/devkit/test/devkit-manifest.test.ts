import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import type {
  ContributionEntry,
  ModuleManifest,
  ModuleRecord,
  ResourceDescriptor,
  ToolchainEntry,
} from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, isKernelError, rawId, recordId, validateRecord, versionString } from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, makeFixtureRepo, manifestWithContributions } from "@musai/test-support";
import { PackageURL } from "packageurl-js";
import { afterEach, describe, expect, it } from "vitest";
import { deriveManifest, MODULE_BUNDLE_GLOBAL } from "../src/manifest.js";
import type { EsbuildMetafile, EsbuildMetafileInput } from "../src/metafile.js";
import { bundleProvenance, PurlDerivationError } from "../src/purl.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function trackedRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  cleanups.push(repo.cleanup);
  return repo;
}

async function trackedTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A dependency's import name and the input key esbuild records for the file it resolved to. */
interface Dependency {
  readonly packageName: string;
  readonly inputPath: string;
}

/** Lays out a dependency under a fresh `node_modules`, with the metafile input of a file in it. */
async function makeDependency(rootDir: string, packageName: string, version: string | undefined): Promise<Dependency> {
  const packageDir = join(rootDir, "node_modules", ...packageName.split("/"));
  await mkdir(packageDir, { recursive: true });
  const manifest: Record<string, unknown> = { name: packageName };
  if (version !== undefined) {
    manifest["version"] = version;
  }
  await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n");
  return { packageName, inputPath: join("node_modules", ...packageName.split("/"), "index.js") };
}

/** Metadata for an entry, `module.ts`, that imports each dependency by name. */
function metafileFor(dependencies: readonly Dependency[]): EsbuildMetafile {
  const inputs: Record<string, EsbuildMetafileInput> = {
    "module.ts": {
      bytes: 1,
      imports: dependencies.map(({ packageName, inputPath }) => ({
        path: inputPath,
        kind: "import-statement",
        original: packageName,
      })),
    },
  };
  for (const { inputPath } of dependencies) {
    inputs[inputPath] = { bytes: 1, imports: [] };
  }
  return { inputs, outputs: {} };
}

describe("a scoped dependency's package url", () => {
  it("encodes its namespace segment, checked against the library's own parse of the emitted string", async () => {
    const rootDir = await trackedTempDir("musai-purl-scoped-");
    const dependency = await makeDependency(rootDir, "@acme/widgets", "2.3.1");

    const { packages: purls } = await bundleProvenance(metafileFor([dependency]), "module.ts", rootDir);
    expect(purls).toHaveLength(1);

    const parsed = PackageURL.fromString(purls[0]!);
    expect(parsed.type).toBe("npm");
    expect(parsed.namespace).toBe("@acme");
    expect(parsed.name).toBe("widgets");
    expect(parsed.version).toBe("2.3.1");
  });

  it("refuses a dependency whose own manifest names no version, by name", async () => {
    const rootDir = await trackedTempDir("musai-purl-noversion-");
    const dependency = await makeDependency(rootDir, "unversioned-package", undefined);

    await expect(bundleProvenance(metafileFor([dependency]), "module.ts", rootDir)).rejects.toThrow(
      PurlDerivationError,
    );
    await expect(bundleProvenance(metafileFor([dependency]), "module.ts", rootDir)).rejects.toThrow(
      /unversioned-package/,
    );
  });
});

/** Pins `packageurl-js`'s output as literals, so a swapped library is caught here rather than at
 * a receiver's parser. It pins the library, not the kernel's derivation. */
describe("the package url a module's own declared source maps to", () => {
  const COMMIT_REF = "abcdef0123456789abcdef0123456789abcdef01";
  const CHECKSUM_DIGEST = "0123456789abcdef".repeat(4);

  it("names an npm source pkg:npm/<namespace>/<name>@<version>, the spec's own native type", () => {
    const purl = new PackageURL("npm", "@angular", "animation", "12.3.1", undefined, undefined).toString();
    expect(purl).toBe("pkg:npm/%40angular/animation@12.3.1");
  });

  it("names a git source pkg:generic with a vcs_url qualifier naming the clone url and the pinned commit", () => {
    const purl = new PackageURL(
      "generic",
      undefined,
      "example-module",
      "1.0.0",
      { vcs_url: `git+https://example.com/acme/example-module.git@${COMMIT_REF}` },
      undefined,
    ).toString();
    expect(purl).toBe(
      "pkg:generic/example-module@1.0.0?vcs_url=git%2Bhttps%3A%2F%2Fexample.com%2Facme%2Fexample-module.git" +
        `%40${COMMIT_REF}`,
    );
  });

  it("names a path source pkg:generic with a checksum qualifier naming the resolved source tree's own digest", () => {
    const purl = new PackageURL(
      "generic",
      undefined,
      "local-tool",
      "0.1.0",
      { checksum: `sha256:${CHECKSUM_DIGEST}` },
      undefined,
    ).toString();
    expect(purl).toBe(`pkg:generic/local-tool@0.1.0?checksum=sha256%3A${CHECKSUM_DIGEST}`);
  });
});

function emptyDescribeBundle(): Uint8Array {
  const source = [
    `var ${MODULE_BUNDLE_GLOBAL} = (function () {`,
    "  function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
    "  function invoke(requestBytes) {",
    "    var request = JSON.parse(new TextDecoder().decode(requestBytes));",
    '    if (request.contribution === "describe") { return respond([]); }',
    '    return respond({ kind: "verdict", label: "open", reason: "not evaluated" });',
    "  }",
    "  return { invoke: invoke };",
    "})();",
  ].join("\n");
  return new TextEncoder().encode(source);
}

/** Pins the kernel's derivation against a literal package url, never one the library made. */
describe("a derived manifest's own dependency list", () => {
  it("names a scoped npm dependency by its literal package url, produced by the kernel's own derivation rather than the library", async () => {
    const rootDir = await trackedTempDir("musai-purl-golden-");

    // `bundleProvenance` reads the dependency's package.json from disk, so it must exist.
    const inputPath = join("node_modules", "@acme", "widgets", "index.js");
    const packageDir = join(rootDir, "node_modules", "@acme", "widgets");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), '{"name":"@acme/widgets","version":"2.3.1"}');

    const metafile: EsbuildMetafile = {
      inputs: {
        "module.ts": { bytes: 1, imports: [{ path: inputPath, kind: "import-statement", original: "@acme/widgets" }] },
        [inputPath]: { bytes: 1, imports: [] },
      },
      outputs: {},
    };

    const sourceTree: ResourceDescriptor = { digest: { gitTree: "a".repeat(40) } };
    const toolchain: ToolchainEntry[] = [{ name: "node", version: versionString("24.0.0") }];

    const { packages } = await bundleProvenance(metafile, "module.ts", rootDir);
    const manifest = await deriveManifest("golden-module", emptyDescribeBundle(), packages, sourceTree, toolchain);

    expect(manifest.packages).toEqual(["pkg:npm/%40acme/widgets@2.3.1"]);
  });
});

describe("a bundle's own dependency list is sorted and stable", () => {
  it("produces the same sorted package list across two builds naming dependencies in a different order", async () => {
    const rootDir = await trackedTempDir("musai-purl-sorted-");
    const zebra = await makeDependency(rootDir, "zebra-package", "1.0.0");
    const alpha = await makeDependency(rootDir, "alpha-package", "1.0.0");

    const { packages: first } = await bundleProvenance(metafileFor([zebra, alpha]), "module.ts", rootDir);
    const { packages: second } = await bundleProvenance(metafileFor([alpha, zebra]), "module.ts", rootDir);

    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
    expect(first).toHaveLength(2);
  });
});

async function install(repo: FixtureRepo, name: string, version: string, manifest: ModuleManifest) {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  const buildReceiptId = recordId({ marker: `build-for-${name}-${version}` });
  return installModule(
    name,
    versionString(version),
    manifest,
    new TextEncoder().encode(`bundle for ${name}@${version}`),
    buildReceiptId,
    store,
    blobStoreOf(repo.workspace),
    index,
  );
}

describe("installing into a workspace with nothing installed", () => {
  it("is not a special case", async () => {
    const repo = await trackedRepo();
    const result = await install(repo, "first-module", "1.0.0", manifestWithContributions([]));

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([
      { id: result.moduleRecordId, name: "first-module", version: "1.0.0" },
    ]);
  });

  it("installs a module contributing nothing, which answers an empty contribution list", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const result = await install(repo, "empty-module", "1.0.0", manifestWithContributions([]));

    const record = (await store.read(result.moduleRecordId, "module")) as ModuleRecord;
    expect(record.manifest.contributions).toEqual([]);
  });

  it("leaves a module record's bundle blob readable by its id", async () => {
    const repo = await trackedRepo();
    const result = await install(repo, "blob-module", "1.0.0", manifestWithContributions([]));
    const bytes = await blobStoreOf(repo.workspace).read(result.bundleId);
    expect(new TextDecoder().decode(bytes)).toBe("bundle for blob-module@1.0.0");
  });
});

describe("installing a name a workspace already holds", () => {
  it("mints a second record the workspace resolves to, with the earlier record still readable by its own id", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const earlier = await install(repo, "shared-name", "1.0.0", manifestWithContributions([]));
    const later = await install(repo, "shared-name", "2.0.0", manifestWithContributions([]));
    expect(later.moduleRecordId).not.toBe(earlier.moduleRecordId);

    const index = new IndexDb(":memory:");
    await index.fold(store);
    expect(index.installedModuleRecords()).toEqual([
      { id: later.moduleRecordId, name: "shared-name", version: "2.0.0" },
    ]);

    const earlierRecord = (await store.read(earlier.moduleRecordId, "module")) as ModuleRecord;
    expect(earlierRecord.name).toBe("shared-name");
    expect(earlierRecord.version).toBe("1.0.0");
  });

  it("from the bytes and receipt of the record the name resolves to, answers that record and leaves the scope's tip unmoved", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const first = await install(repo, "rebuilt-module", "1.0.0", manifestWithContributions([]));
    const tipAfterFirst = await store.tip();

    const second = await install(repo, "rebuilt-module", "1.0.0", manifestWithContributions([]));

    expect(second.moduleRecordId).toBe(first.moduleRecordId);
    expect(second.bundleId).toBe(first.bundleId);
    expect(tipAfterFirst).not.toBeNull();
    expect(await store.tip()).toBe(tipAfterFirst);
  });
});

describe("a module manifest whose declarations disagree with each other", () => {
  it("a contribution answering at a point neither the kernel nor the workspace declares is refused, naming the module, the contribution and the point, leaving no module record and no blob", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "stray-point-module/verdicts",
        id: "stray-point-module/decides",
        version: versionString("1"),
        input: true,
        output: true,
        documentation: "d",
      },
    ]);

    const refusal = await install(repo, "stray-point-module", "1.0.0", manifest).catch((error: unknown) => error);
    expect(isKernelError(refusal)).toBe(true);
    if (isKernelError(refusal)) {
      expect(refusal.reason).toBe("declaration-conflict");
      expect(refusal.about).toEqual([
        "stray-point-module",
        "stray-point-module/decides",
        "stray-point-module/verdicts",
      ]);
      expect(refusal.message).toMatch(/stray-point-module.*stray-point-module\/decides.*stray-point-module\/verdicts/);
      expect(refusal.message).toMatch(/neither this kernel ships nor this workspace holds/);
    }

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([]);

    const bundleBytes = new TextEncoder().encode("bundle for stray-point-module@1.0.0");
    await expect(blobStoreOf(repo.workspace).read(rawId(bundleBytes))).rejects.toThrow("blob not found");
  });

  it("an operation contribution whose input declares a channel, a principal, a signing key or an envelope field is refused, naming which, leaving no module record and no blob", async () => {
    for (const property of ["via", "principal", "key", "plan", "expectHead"]) {
      const repo = await trackedRepo();
      const manifest = manifestWithContributions([
        {
          kind: "operation",
          id: "asserting-module/stamps",
          version: versionString("1"),
          input: {
            type: "object",
            additionalProperties: false,
            properties: { subject: { type: "string" }, [property]: { type: "string" } },
          },
          output: true,
          documentation: "d",
          effect: "write",
          authority: null,
        },
      ]);

      const refusal = await install(repo, "asserting-module", "1.0.0", manifest).catch((error: unknown) => error);
      expect(isKernelError(refusal)).toBe(true);
      if (isKernelError(refusal)) {
        expect(refusal.reason).toBe("invalid-input");
        expect(refusal.about).toEqual(["asserting-module"]);
        expect(refusal.message).toContain("asserting-module/stamps");
        expect(refusal.message).toContain(`input property named ${property},`);
      }

      const index = new IndexDb(":memory:");
      await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      expect(index.installedModuleRecords()).toEqual([]);
      const bundleBytes = new TextEncoder().encode("bundle for asserting-module@1.0.0");
      await expect(blobStoreOf(repo.workspace).read(rawId(bundleBytes))).rejects.toThrow("blob not found");
    }
  });

  it("an operation contribution whose input declares none of them installs", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "operation",
        id: "plain-module/stamps",
        version: versionString("1"),
        input: { type: "object", additionalProperties: false, properties: { subject: { type: "string" } } },
        output: true,
        documentation: "d",
        effect: "write",
        authority: null,
      },
    ]);

    await expect(install(repo, "plain-module", "1.0.0", manifest)).resolves.toMatchObject({
      moduleRecordId: expect.stringMatching(/^sha256:/),
    });
  });

  it("an operation contribution whose input is not a plain closed object is refused, naming what it lacks or carries, leaving no module record and no blob", async () => {
    const closed = { type: "object", additionalProperties: false, properties: { subject: { type: "string" } } };
    const cases: readonly { readonly input: unknown; readonly keyword: string }[] = [
      { input: true, keyword: "type" },
      { input: { type: "object" }, keyword: "properties" },
      { input: { type: "object", additionalProperties: false }, keyword: "properties" },
      { input: { type: "object", properties: { subject: { type: "string" } } }, keyword: "additionalProperties" },
      { input: { ...closed, additionalProperties: true }, keyword: "additionalProperties" },
      { input: { ...closed, type: "array" }, keyword: "type" },
      { input: { ...closed, $ref: "#/$defs/anything" }, keyword: "$ref" },
      { input: { ...closed, allOf: [{ properties: { via: { type: "string" } } }] }, keyword: "allOf" },
      { input: { ...closed, anyOf: [{ properties: { via: { type: "string" } } }] }, keyword: "anyOf" },
      { input: { ...closed, oneOf: [{ properties: { via: { type: "string" } } }] }, keyword: "oneOf" },
      { input: { ...closed, not: { required: ["subject"] } }, keyword: "not" },
      { input: { ...closed, if: { required: ["subject"] } }, keyword: "if" },
      { input: { ...closed, patternProperties: { "^p": { type: "string" } } }, keyword: "patternProperties" },
    ];
    for (const { input, keyword } of cases) {
      const repo = await trackedRepo();
      const manifest = manifestWithContributions([
        {
          kind: "operation",
          id: "open-module/stamps",
          version: versionString("1"),
          input,
          output: true,
          documentation: "d",
          effect: "write",
          authority: null,
        },
      ]);

      const refusal = await install(repo, "open-module", "1.0.0", manifest).catch((error: unknown) => error);
      expect(isKernelError(refusal), JSON.stringify(input)).toBe(true);
      if (isKernelError(refusal)) {
        expect(refusal.reason).toBe("invalid-input");
        expect(refusal.about).toEqual(["open-module"]);
        expect(refusal.message).toContain("open-module/stamps");
        const shortfall = refusal.message.slice(
          refusal.message.indexOf("input schema"),
          refusal.message.indexOf(": an operation's input"),
        );
        expect(shortfall, JSON.stringify(input)).toContain(keyword);
      }

      const index = new IndexDb(":memory:");
      await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      expect(index.installedModuleRecords()).toEqual([]);
      const bundleBytes = new TextEncoder().encode("bundle for open-module@1.0.0");
      await expect(blobStoreOf(repo.workspace).read(rawId(bundleBytes))).rejects.toThrow("blob not found");
    }
  });

  it("an input schema that is not a closed object is refused only on an operation contribution", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "view",
        id: "open-view-module/rows",
        version: versionString("1"),
        input: { type: "object", allOf: [{ properties: { via: { type: "string" } } }] },
        output: true,
        documentation: "d",
      },
    ]);

    await expect(install(repo, "open-view-module", "1.0.0", manifest)).resolves.toMatchObject({
      moduleRecordId: expect.stringMatching(/^sha256:/),
    });
  });

  it("a fold table this workspace's engine cannot serve is refused, leaving no module record and no blob", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "fold",
        id: "unservable-fold-module/rows",
        version: versionString("1"),
        input: true,
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tag"],
                properties: { tag: { type: "array" } },
              },
            },
          },
        },
        documentation: "d",
      },
    ]);

    const refusal = await install(repo, "unservable-fold-module", "1.0.0", manifest).catch((error: unknown) => error);
    expect(isKernelError(refusal)).toBe(true);
    if (isKernelError(refusal)) {
      expect(refusal.reason).toBe("invalid-input");
      expect(refusal.about).toEqual(["unservable-fold-module/rows", "unservable_fold_module_rows"]);
    }

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([]);

    const bundleBytes = new TextEncoder().encode("bundle for unservable-fold-module@1.0.0");
    await expect(blobStoreOf(repo.workspace).read(rawId(bundleBytes))).rejects.toThrow("blob not found");
  });

  it("a query declaring a table no query may declare is refused, leaving no module record and no blob", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "query",
        id: "undeclarable-query-module/watermark",
        version: versionString("1"),
        input: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {},
          statement: "SELECT commit_sha FROM watermark",
          tables: ["watermark"],
        },
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [],
                properties: { commit_sha: { type: "string" } },
              },
            },
          },
        },
        documentation: "d",
      },
    ]);

    const refusal = await install(repo, "undeclarable-query-module", "1.0.0", manifest).catch(
      (error: unknown) => error,
    );
    expect(isKernelError(refusal)).toBe(true);
    if (isKernelError(refusal)) {
      expect(refusal.reason).toBe("invalid-input");
      expect(refusal.about).toEqual(["undeclarable-query-module/watermark", "watermark"]);
    }

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([]);

    const bundleBytes = new TextEncoder().encode("bundle for undeclarable-query-module@1.0.0");
    await expect(blobStoreOf(repo.workspace).read(rawId(bundleBytes))).rejects.toThrow("blob not found");
  });

  it("a fold table and a query reading it install together, since the manifest's own declarations are read alongside the workspace's", async () => {
    const repo = await trackedRepo();
    const manifest = manifestWithContributions([
      {
        kind: "query",
        id: "paired-pack/reads",
        version: versionString("1"),
        input: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {},
          statement: "SELECT tag FROM paired_pack_rows ORDER BY tag ASC",
          tables: ["paired_pack_rows"],
        },
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tag"],
                properties: { tag: { type: "string" } },
              },
            },
          },
        },
        documentation: "d",
      },
      {
        kind: "fold",
        id: "paired-pack/rows",
        version: versionString("1"),
        input: true,
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tag"],
                properties: { tag: { type: "string" } },
              },
            },
          },
        },
        documentation: "d",
      },
    ]);

    const result = await install(repo, "paired-pack", "1.0.0", manifest);

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([
      { id: result.moduleRecordId, name: "paired-pack", version: "1.0.0" },
    ]);
  });

  it("a re-pin taking away the table another pack's query reads is refused, leaving the pack it would have re-pinned where it was", async () => {
    const repo = await trackedRepo();
    const row = {
      type: "object",
      additionalProperties: false,
      required: ["tag"],
      properties: { tag: { type: "string" } },
    };
    const rows = {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: { rows: { type: "array", items: row } },
    };
    const table = await install(
      repo,
      "table-pack",
      "1.0.0",
      manifestWithContributions([
        {
          kind: "fold",
          id: "table-pack/rows",
          version: versionString("1"),
          input: true,
          output: rows,
          documentation: "d",
        },
      ]),
    );
    await install(
      repo,
      "query-pack",
      "1.0.0",
      manifestWithContributions([
        {
          kind: "query",
          id: "query-pack/reads",
          version: versionString("1"),
          input: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {},
            statement: "SELECT tag FROM table_pack_rows ORDER BY tag ASC",
            tables: ["table_pack_rows"],
          },
          output: rows,
          documentation: "d",
        },
      ]),
    );

    // The re-pin declares no fold table, so the other pack's query would lose the table it reads.
    const refusal = await install(repo, "table-pack", "1.1.0", manifestWithContributions([])).catch(
      (error: unknown) => error,
    );

    expect(isKernelError(refusal)).toBe(true);
    if (isKernelError(refusal)) {
      expect(refusal.about).toContain("query-pack/reads");
      expect(refusal.detail).toContain("table_pack_rows");
    }
    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords().find((held) => held.name === "table-pack")).toEqual({
      id: table.moduleRecordId,
      name: "table-pack",
      version: "1.0.0",
    });
  });

  /** Lands a module record as a peer's commit does, unchecked by any install. */
  async function landModule(repo: FixtureRepo, name: string, entries: readonly ContributionEntry[]): Promise<void> {
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const moduleRecord: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name,
      version: versionString("1.0.0"),
      manifest: manifestWithContributions([...entries]),
      bundle: null,
      build: null,
    };
    await store.putMany([{ kind: "module", value: moduleRecord }]);
  }

  it("a query already failing on this machine is that pack's own business, and installing an unrelated pack is not refused for it", async () => {
    const repo = await trackedRepo();
    await landModule(repo, "already-failing-query-pack", [
      {
        kind: "query",
        id: "already-failing-query-pack/absent",
        version: versionString("1"),
        input: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {},
          statement: "SELECT nothing FROM claims",
          tables: ["claims"],
        },
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: [], properties: {} },
            },
          },
        },
        documentation: "d",
      },
    ]);

    const result = await install(repo, "unrelated-pack", "1.0.0", manifestWithContributions([]));

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(
      index
        .installedModuleRecords()
        .map((held) => held.name)
        .sort(),
    ).toEqual(["already-failing-query-pack", "unrelated-pack"]);
    expect(result.moduleRecordId).toBeDefined();
  });

  it("a fold declaration this engine already refuses is that pack's own business, and installing an unrelated pack is not refused for it", async () => {
    const repo = await trackedRepo();
    await landModule(repo, "already-refused-fold-pack", [
      {
        kind: "fold",
        id: "already-refused-fold-pack/rows",
        version: versionString("1"),
        input: true,
        output: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [],
                // The identifier rule admits this word and the engine reserves it.
                properties: { order: { type: "string" } },
              },
            },
          },
        },
        documentation: "d",
      },
    ]);

    await install(repo, "unrelated-pack", "1.0.0", manifestWithContributions([]));

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(
      index
        .installedModuleRecords()
        .map((held) => held.name)
        .sort(),
    ).toEqual(["already-refused-fold-pack", "unrelated-pack"]);
  });
});

describe("two contributions differing only in version", () => {
  it("fold to two entries and two index rows", async () => {
    const repo = await trackedRepo();
    const moduleName = "versioned-module";
    const entries: ContributionEntry[] = [
      {
        kind: "parser",
        id: `${moduleName}/exit-code`,
        version: versionString("1"),
        input: true,
        output: true,
        documentation: "d",
      },
      {
        kind: "parser",
        id: `${moduleName}/exit-code`,
        version: versionString("2"),
        input: true,
        output: true,
        documentation: "d",
      },
    ];
    const result = await install(repo, moduleName, "1.0.0", manifestWithContributions(entries));

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const contributions = index.contributionsOf("parser");
    expect(contributions).toHaveLength(2);
    expect(contributions.map((entry) => entry.entry.version).sort()).toEqual(["1", "2"]);
    expect(contributions.every((entry) => entry.moduleRecord === result.moduleRecordId)).toBe(true);
  });
});

describe("two contribution ids differing only in case", () => {
  it("are two ids, never merged into one", async () => {
    const repo = await trackedRepo();
    const moduleName = "case-ids-module";
    const entries: ContributionEntry[] = [
      {
        kind: "parser",
        id: `${moduleName}/Thing`,
        version: versionString("1"),
        input: true,
        output: true,
        documentation: "d",
      },
      {
        kind: "parser",
        id: `${moduleName}/thing`,
        version: versionString("1"),
        input: true,
        output: true,
        documentation: "d",
      },
    ];
    const result = await install(repo, moduleName, "1.0.0", manifestWithContributions(entries));

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const record = (await store.read(result.moduleRecordId, "module")) as ModuleRecord;
    expect(record.manifest.contributions.map((entry) => entry.id).sort()).toEqual([
      `${moduleName}/Thing`,
      `${moduleName}/thing`,
    ]);

    const index = new IndexDb(":memory:");
    await index.fold(store);
    expect(index.contributionById(`${moduleName}/Thing`)?.entry.id).toBe(`${moduleName}/Thing`);
    expect(index.contributionById(`${moduleName}/thing`)?.entry.id).toBe(`${moduleName}/thing`);
  });
});

describe("a contribution's kind names the point it answers at", () => {
  const moduleName = "point-names-module";
  const contributionId = `${moduleName}/finding`;

  function moduleDeclaringKind(kind: string): unknown {
    return {
      kind: "module",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: moduleName,
      version: "1.0.0",
      manifest: manifestWithContributions([
        { kind, id: contributionId, version: versionString("1"), input: true, output: true, documentation: "d" },
      ]),
      bundle: null,
      build: null,
      supersedes: [],
    };
  }

  it("a kind naming a module-namespaced point validates, the name carried through unchanged", () => {
    const result = validateRecord(moduleDeclaringKind(`${moduleName}/verdict-shape`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.record as ModuleRecord).manifest.contributions[0]?.kind).toBe(`${moduleName}/verdict-shape`);
    }
  });

  it.each([
    ["an empty kind", ""],
    ["a kind carrying whitespace", "verdict shape"],
    ["the reserved describe kind", "describe"],
  ])("%s is refused, naming the contribution id", (_label, kind) => {
    const result = validateRecord(moduleDeclaringKind(kind));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(contributionId);
    }
  });
});

describe("a module record owns its operation contributions' input rule", () => {
  const moduleName = "operation-input-module";
  const contributionId = `${moduleName}/stamps`;

  function moduleDeclaringOperationInput(input: unknown): unknown {
    return {
      kind: "module",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: moduleName,
      version: "1.0.0",
      manifest: manifestWithContributions([
        {
          kind: "operation",
          id: contributionId,
          version: versionString("1"),
          input,
          output: true,
          documentation: "d",
          effect: "write",
          authority: null,
        },
      ]),
      bundle: null,
      build: null,
      supersedes: [],
    };
  }

  it("a record whose operation input is a plain closed object validates", () => {
    const input = { type: "object", additionalProperties: false, properties: { subject: { type: "string" } } };
    expect(validateRecord(moduleDeclaringOperationInput(input)).ok).toBe(true);
  });

  it.each([
    ["an open input", { type: "object", properties: { subject: { type: "string" } } }],
    ["an input naming the principal", { type: "object", additionalProperties: false, properties: { principal: {} } }],
    ["an input naming plan", { type: "object", additionalProperties: false, properties: { plan: {} } }],
  ])("a record carrying %s is refused however it arrives, naming the contribution", (_label, input) => {
    const result = validateRecord(moduleDeclaringOperationInput(input));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(contributionId);
    }
  });
});
