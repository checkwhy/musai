import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import {
  type ClaimTypeDeclaration,
  type Clock,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  type ModuleManifest,
  type ModuleRecord,
  type RecordId,
  versionString,
} from "@musai/records";
import { MUSAI_DIR, type RecordStore, Store } from "@musai/store";

export async function foldedIndex(store: RecordStore): Promise<IndexDb> {
  const index = new IndexDb(":memory:");
  await index.fold(store);
  return index;
}

/** Stands in for all but the contributions, for a module a test installs and never builds. */
export function manifestWithContributions(entries: readonly ContributionEntry[]): ModuleManifest {
  return {
    protocolVersion: 1,
    contributions: [...entries],
    sourceTree: { digest: { gitTree: "a".repeat(40) } },
    toolchain: [{ name: "node", version: versionString("24.0.0") }],
    packages: [],
  };
}

/** Writes around `installModule`, which has no data-only arm; seed under a name nothing else
 * installs, since a later record of it re-pins the module and drops the seeded types. */
export async function declareClaimTypes(
  store: Store,
  declarations: readonly ClaimTypeDeclaration[],
): Promise<RecordId[]> {
  const byModule = new Map<string, ClaimTypeDeclaration[]>();
  for (const declaration of declarations) {
    const slash = declaration.type.indexOf("/");
    if (slash === -1) {
      throw new Error(`a module cannot declare a type its own name does not namespace: ${declaration.type}`);
    }
    const moduleName = declaration.type.slice(0, slash);
    byModule.set(moduleName, [...(byModule.get(moduleName) ?? []), declaration]);
  }

  const ids: RecordId[] = [];
  for (const [name, entries] of byModule) {
    const sorted = [...entries].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    const manifest = manifestWithContributions(
      sorted.map((declaration) => ({
        kind: "claim-type",
        id: declaration.type,
        version: versionString("1"),
        input: {
          identityDimensions: declaration.identityDimensions,
          ...(declaration.canonical === undefined ? {} : { canonical: declaration.canonical }),
        },
        output: true,
        documentation: `the ${declaration.type} claim type`,
      })),
    );
    const minted = await store.putMany([
      {
        kind: "module",
        value: {
          kind: "module",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
          name,
          version: versionString("1.0.0"),
          manifest,
          bundle: null,
          build: null,
          supersedes: [],
        },
      },
    ]);
    ids.push(...minted);
  }
  return ids;
}

/** Writes through the store, skipping an install's checks, so a contribution at a point no
 * workspace declares lands as it stands. */
export async function installModuleRecord(
  workspace: string,
  scope: string,
  name: string,
  contributions: readonly ContributionEntry[],
  now: Clock,
): Promise<void> {
  const store = new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now });
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1"),
    manifest: manifestWithContributions(contributions),
    bundle: null,
    build: null,
  };
  await store.putMany([{ kind: "module", value: moduleRecord }]);
}

export async function installEmptyModule(workspace: string, scope: string, name: string, now: Clock): Promise<void> {
  await installModuleRecord(workspace, scope, name, [], now);
}
