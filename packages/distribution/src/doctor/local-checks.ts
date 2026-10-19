import { dirname, join } from "node:path";
import type { Workspace } from "@musai/api-core";
import { INDEX_SCHEMA_VERSION } from "@musai/fold";
import { partitionRequirementRows } from "@musai/modules";
import { BLOBS_DIR, isKernelError } from "@musai/records";
import {
  BinaryNotFoundError,
  BindingError,
  CANARY_CHANNELS,
  type CanaryChannel,
  type ChannelStatus,
  containerEngineAvailable,
  DEFAULT_CONTAINER_ENGINE,
  MACHINE_TOOLS_FILE,
  readBindings,
  readMachineTools,
  resolveBinaries,
  runCanary,
} from "@musai/run";
import {
  gitCheckIgnored,
  gitLooseObjectCount,
  KeyFileError,
  LOCAL_DIR,
  listViewWorktrees,
  oneLevelRecordCount,
  PACK_THRESHOLD,
  readKeyFile,
} from "@musai/store";
import { isBlobStore, readBlobDirectory } from "../blob-dir.js";

/** One fact `doctor` checked about local state. A person pastes it into an issue, so it never
 * carries a key, a binding's value or an environment variable's value. */
export interface LocalCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** `readKeyFile` refuses a mode wider than 0600, naming only the file and the mode. */
async function keyFileCheck(localDir: string): Promise<LocalCheck> {
  try {
    await readKeyFile(localDir);
    return { name: "key-file", ok: true, detail: "the workspace key file is owner-only" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "key-file", ok: true, detail: "no workspace key minted yet" };
    }
    if (error instanceof KeyFileError) {
      return { name: "key-file", ok: false, detail: error.message };
    }
    throw error;
  }
}

async function bindingsFileCheck(localDir: string): Promise<LocalCheck> {
  try {
    await readBindings(localDir);
    return { name: "bindings-file", ok: true, detail: "the bindings file is owner-only" };
  } catch (error) {
    if (error instanceof BindingError) {
      return { name: "bindings-file", ok: false, detail: error.message };
    }
    throw error;
  }
}

/** Whether an enclosing project ignores the local directory. Committing the store is supported;
 * committing the fold or the key beside it is not. */
async function enclosingRepositoryCheck(musaiDir: string, localDir: string): Promise<LocalCheck> {
  const status = await gitCheckIgnored(localDir, dirname(musaiDir));
  if (status === "not-ignored") {
    return {
      name: "enclosing-repository",
      ok: false,
      detail: `${localDir} sits inside a git working tree that does not ignore it; add it to that tree's own ignore file`,
    };
  }
  return {
    name: "enclosing-repository",
    ok: true,
    detail:
      status === "ignored" ? "the local directory is ignored by the enclosing repository" : "no enclosing repository",
  };
}

/** Blobs once lived in a directory, inside `.musai/` or beside it, which nothing reads now. */
async function blobStoreCheck(musaiDir: string): Promise<LocalCheck> {
  const stores: string[] = [];
  for (const dir of [join(musaiDir, BLOBS_DIR), join(dirname(musaiDir), BLOBS_DIR)]) {
    if (isBlobStore(await readBlobDirectory(dir))) {
      stores.push(dir);
    }
  }
  return stores.length > 0
    ? {
        name: "blob-store",
        ok: false,
        detail: stores
          .map((dir) => `${dir} holds blobs nothing reads; move them in with \`musai lab blobs import ${dir}\``)
          .join("; "),
      }
    : { name: "blob-store", ok: true, detail: "blobs live on the store's blobs branch" };
}

/** A record at a one-level path is refused by every fold, so the scope reads as if it lacked it. */
async function recordLayoutCheck(opened: Workspace): Promise<LocalCheck> {
  const count = await oneLevelRecordCount(opened.ctx, opened.store.scope);
  return count > 0
    ? {
        name: "record-layout",
        ok: false,
        detail: `scope ${opened.store.scope} holds ${count} record${count === 1 ? "" : "s"} at one-level paths, which nothing reads; rewrite it with \`musai lab store relayout\``,
      }
    : { name: "record-layout", ok: true, detail: "every record path is two levels deep" };
}

/** Past the threshold the next write packs; a count above it says a pack did not happen. */
async function looseObjectsCheck(opened: Workspace): Promise<LocalCheck> {
  const count = await gitLooseObjectCount(opened.ctx);
  return {
    name: "loose-objects",
    ok: count < PACK_THRESHOLD,
    detail: `${count} loose objects; the store packs itself past ${PACK_THRESHOLD}`,
  };
}

/** One row per program this machine adds to its runs' PATH, since no other machine's list is it. */
async function machineToolChecks(localDir: string): Promise<LocalCheck[]> {
  return Promise.all(
    (await readMachineTools(localDir)).map(async (tool) => {
      try {
        await resolveBinaries([tool]);
        return { name: "machine-tools", ok: true, detail: `${tool} is on this machine's PATH, added to every run's` };
      } catch (error) {
        if (!(error instanceof BinaryNotFoundError)) {
          throw error;
        }
        return {
          name: "machine-tools",
          ok: false,
          detail: `${tool} is listed in ${MACHINE_TOOLS_FILE} but not on PATH`,
        };
      }
    }),
  );
}

/** The scenario suite signs with this key, and its private half is in musai's own repository, so
 * any signature it makes proves nothing. */
const PUBLISHED_SCENARIO_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIDp2OVF0MIrCMS9WLECtt+Z+87OZYPnVve1sWoEzvlKq";

function publishedKeyCheck(opened: Workspace): LocalCheck {
  const trusting = opened.allowedSigners.filter((signer) => signer.key === PUBLISHED_SCENARIO_KEY);
  return trusting.length > 0
    ? {
        name: "published-key",
        ok: false,
        detail: `allowed-signers trusts the scenario suite's key for ${trusting.map((signer) => signer.principals).join(", ")}; its private half is published, so remove the line`,
      }
    : { name: "published-key", ok: true, detail: "no published key is trusted" };
}

/** Always passes: `openWorkspace` already folded the index to this version. */
function indexSchemaCheck(): LocalCheck {
  return { name: "index-schema", ok: true, detail: `index schema version ${INDEX_SCHEMA_VERSION}` };
}

/** One failed check per contributed declaration the fold refused, saying what clears it. */
function contributedDeclarationChecks(opened: Workspace): LocalCheck[] {
  return opened.foldRefusals.map((refusal) => ({
    name: "contributed-declarations",
    ok: false,
    detail: refusal.settled
      ? `${refusal.reason} — re-pinning the pack clears this, and so does an engine that takes the declaration`
      : `${refusal.reason} — the next open tries it again`,
  }));
}

/** One failed check per requirement entry that is not the data its point declares. */
function malformedRequirementChecks(opened: Workspace): LocalCheck[] {
  return partitionRequirementRows(opened.index.contributionsOf("requirement")).malformed.map(
    ({ moduleName, entry }) => ({
      name: "requirement-entries",
      ok: false,
      detail: `the requirement ${entry.id} declared by ${moduleName} does not declare a binary, a version predicate, what needs it and how to install it — re-pinning ${moduleName} clears this`,
    }),
  );
}

/** One row per view worktree whose slug no case in the fold carries. */
async function viewWorktreeChecks(opened: Workspace): Promise<LocalCheck[]> {
  const worktrees = await listViewWorktrees(opened.ctx, new Set(opened.index.caseSlugs()));
  const stale = worktrees.filter((worktree) => worktree.stale);
  if (stale.length === 0) {
    return [{ name: "view-worktrees", ok: true, detail: "no stale view worktree" }];
  }
  return stale.map((worktree) => ({
    name: "view-worktrees",
    ok: false,
    detail: `stale view worktree for ${worktree.slug} at ${worktree.path}`,
  }));
}

/** Written from the channel and status alone: the canary's detail can name a scratch path, and the
 * report is byte-identical across runs at one head. */
const CHANNEL_WORDS: Record<CanaryChannel, string> = {
  home: "your home directory",
  "git-global-config": "your global git configuration",
  "git-config-value": "a value set in your git configuration",
  "ssh-agent": "your ssh agent",
};

function channelDetail(channel: CanaryChannel, status: ChannelStatus): string {
  const words = CHANNEL_WORDS[channel];
  switch (status) {
    case "absent":
      return `a check's run is not offered ${words}`;
    case "denied":
      return `a check's run is offered ${words} and cannot reach it`;
    case "present":
      return `a check's run reaches ${words}`;
  }
}

/** One check per channel the canary probes, failing on `present` alone: `absent` and `denied` are
 * hygiene holding. */
async function canaryChecks(): Promise<LocalCheck[]> {
  try {
    const report = await runCanary();
    return CANARY_CHANNELS.map((channel) => {
      const result = report.channels.find((entry) => entry.channel === channel)!;
      return {
        name: `canary-${channel}`,
        ok: result.status !== "present",
        detail: channelDetail(channel, result.status),
      };
    });
  } catch (error) {
    if (isKernelError(error)) {
      return [{ name: "canary", ok: false, detail: error.detail }];
    }
    throw error;
  }
}

/** A resolved `docker` binary says nothing of its daemon, which a run declaring an image needs. */
async function containerEngineCheck(): Promise<LocalCheck> {
  const engine = DEFAULT_CONTAINER_ENGINE;
  return (await containerEngineAvailable(engine))
    ? { name: "container-engine", ok: true, detail: `${engine} answers: a run declaring an image can hold it` }
    : {
        name: "container-engine",
        ok: false,
        detail: `${engine} does not answer \`${engine} info\`: a run declaring an image is refused, and a check, which declares none, runs without it`,
      };
}

/** The kernel's own half of a receiver's precheck: facts about local state no module declares. */
export async function localChecks(opened: Workspace): Promise<readonly LocalCheck[]> {
  const localDir = join(opened.ctx.gitDir, LOCAL_DIR);
  const forAuthor = opened.clearance === undefined;
  return [
    await keyFileCheck(localDir),
    await bindingsFileCheck(localDir),
    await enclosingRepositoryCheck(opened.ctx.gitDir, localDir),
    await blobStoreCheck(opened.ctx.gitDir),
    // The store's record and object counts include what a seal hides from a cleared fold.
    ...(forAuthor ? [await recordLayoutCheck(opened)] : []),
    publishedKeyCheck(opened),
    ...(forAuthor ? [await looseObjectsCheck(opened)] : []),
    ...(await machineToolChecks(localDir)),
    indexSchemaCheck(),
    ...contributedDeclarationChecks(opened),
    ...malformedRequirementChecks(opened),
    // A cleared fold lacks the slug of a case sealed from it, which the author's open view names.
    ...(forAuthor ? await viewWorktreeChecks(opened) : []),
    ...(await canaryChecks()),
    await containerEngineCheck(),
  ];
}
