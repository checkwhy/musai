import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type RevokedRelease,
  releaseStanding,
  type StandingSeal,
  sealStanding,
  type Workspace,
  withdrawnUnverified,
} from "@musai/api-core";
import { INDEX_SCHEMA_VERSION } from "@musai/fold";
import type { CallLogRequest, CallLogResponse } from "@musai/mcp";
import { partitionRequirementRows } from "@musai/modules";
import { BLOBS_DIR, isKernelError, type KernelError, type RecordId, type TrustFileError } from "@musai/records";
import {
  BINDINGS_FILE_NAME,
  BinaryNotFoundError,
  BindingError,
  type BindingsFile,
  CANARY_CHANNELS,
  type CanaryChannel,
  type ChannelStatus,
  containerEngineAvailable,
  DEFAULT_CONTAINER_ENGINE,
  type LayerDeclaration,
  MACHINE_TOOLS_FILE,
  PROCESS_TABLE,
  ProcessTableError,
  pathBindings,
  printable,
  readBindings,
  readCheckoutBindings,
  readMachineTools,
  readProcessTable,
  resolveBinaries,
  runCanary,
  type StandingRoot,
  standingRoots,
  UNRECORDABLE_BINDING_REMEDY,
} from "@musai/run";
import {
  CALL_LOG_DIR,
  gitCheckIgnored,
  gitLooseObjectCount,
  initHolders,
  KeyFileError,
  LOCAL_DIR,
  listViewWorktrees,
  MUSAI_DIR,
  oneLevelRecordCount,
  PACK_THRESHOLD,
  readKeyFile,
  readTrustBranch,
} from "@musai/store";
import { sshSigningFault, trustFileFaults } from "@musai/trust";
import { isBlobStore, readBlobDirectory } from "../blob-dir.js";
import { forkRemedy, SHORT_ID_LENGTH, shortIdOf } from "../claim-ref.js";
import { markdownCommand } from "../text.js";
import { signingKeyPrincipals, withdrawnIn } from "../withdrawn-in.js";

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

/** A bindings file no reader takes leaves no binding to judge, so it is one row alone. */
async function bindingsChecks(opened: Workspace, localDir: string): Promise<LocalCheck[]> {
  let bindings: BindingsFile;
  try {
    bindings = await readBindings(localDir);
  } catch (error) {
    if (error instanceof BindingError) {
      return [{ name: "bindings-file", ok: false, detail: error.message }];
    }
    throw error;
  }
  return [
    { name: "bindings-file", ok: true, detail: "the bindings file is owner-only" },
    ...(await bindingPathChecks(bindings, opened.layerDeclarations, localDir)),
  ];
}

function rootWords(root: StandingRoot): string {
  return root.checkout === null ? "the working tree holding the workspace" : `the checkout ${root.checkout}`;
}

/** One row per plain binding naming an absolute path, never its value; with no recipe in hand, a
 * path under a root passes naming it, since a verb's run stands on its recipe's first checkout. */
async function bindingPathChecks(
  bindings: BindingsFile,
  layerDeclarations: ReadonlyMap<string, LayerDeclaration>,
  localDir: string,
): Promise<LocalCheck[]> {
  let roots: readonly StandingRoot[];
  try {
    roots = await standingRoots(localDir);
  } catch (error) {
    // The checkouts-file row names the refusal, and no root stands to judge a binding against.
    if (error instanceof BindingError) {
      return [];
    }
    throw error;
  }
  const named = pathBindings(bindings, layerDeclarations, roots);
  if (named.length === 0) {
    return [
      {
        name: "binding-paths",
        ok: true,
        detail: "no plain binding names an absolute path, so a run on any recipe records each as it is",
      },
    ];
  }
  return named.map(({ name, roots: holding, eachRooted }) =>
    holding.length === 0
      ? {
          name: "binding-paths",
          ok: false,
          detail: `the binding ${name} in ${BINDINGS_FILE_NAME} names ${eachRooted ? "absolute paths under different roots, and no single root a run here stands on holds them all" : "an absolute path under no checkout a run here stands on"}, so every run declaring it plain is refused; ${UNRECORDABLE_BINDING_REMEDY}`,
        }
      : {
          name: "binding-paths",
          ok: true,
          detail: `the binding ${name} in ${BINDINGS_FILE_NAME} names an absolute path under ${holding.map(rootWords).join(" and ")}, which a run declaring it plain records only when the first checkout its recipe names stands there, and refuses on a recipe naming another or none`,
        },
  );
}

async function checkoutsFileCheck(localDir: string): Promise<LocalCheck> {
  try {
    await readCheckoutBindings(localDir);
    return { name: "checkouts-file", ok: true, detail: "every checkout the checkouts file binds names a directory" };
  } catch (error) {
    if (error instanceof BindingError) {
      return { name: "checkouts-file", ok: false, detail: error.message };
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
          .map(
            (dir) =>
              `${printable(dir)} holds blobs nothing reads; move them in with ${markdownCommand(["musai", "lab", "blobs", "import", dir])}`,
          )
          .join("; "),
      }
    : { name: "blob-store", ok: true, detail: "blobs live on the store's blobs branch" };
}

/** An enclosing working tree ignores a holder, so one is clutter and never sets the exit. */
async function initHolderChecks(musaiDir: string): Promise<LocalCheck[]> {
  const holders = await initHolders(dirname(musaiDir));
  if (holders.length === 0) {
    return [{ name: "init-holders", ok: true, detail: "no holder an init left" }];
  }
  return holders.map((holder) => ({
    name: "init-holders",
    ok: false,
    detail: `${holder} was left by an init stopped before it finished; once no init is running, remove it`,
  }));
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

/** A forked slot reads open until one successor supersedes every claim live at it. */
function forkedSlotChecks(opened: Workspace): LocalCheck[] {
  const forked = opened.index.forkedSlots();
  if (forked.length === 0) {
    return [{ name: "forked-slots", ok: true, detail: "no slot holds live claims judged differently" }];
  }
  return forked.map((slot) => {
    const fork = opened.index.forkAtSlot(slot);
    const claims = fork.map(({ id }) => shortIdOf(id));
    return {
      name: "forked-slots",
      ok: false,
      detail: `slot ${shortIdOf(slot)} holds live claims judged differently (${claims.join(", ")}); ${forkRemedy(fork[0]!.type)}`,
    };
  });
}

/** A forked slug answers no read by it until one successor supersedes every case live under it.
 * The row names the cases by short id alone, since the slug may be a sealed case's. */
function forkedSlugChecks(opened: Workspace): LocalCheck[] {
  const forked = opened.index.forkedSlugs();
  if (forked.length === 0) {
    return [{ name: "forked-slugs", ok: true, detail: "no slug is held by more than one live case" }];
  }
  return forked.map((slug) => {
    const cases = opened.index.casesAtSlug(slug).map(({ id }) => shortIdOf(id));
    return {
      name: "forked-slugs",
      ok: false,
      detail: `live cases ${cases.join(", ")} hold one slug; ${forkRemedy("case")}`,
    };
  });
}

/** A seal or a revocation whose signature does not verify withholds all the same, so its author
 * is told; the rows name short ids alone, so doctor stays safe to paste. */
async function unverifiedChecks(opened: Workspace): Promise<LocalCheck[]> {
  try {
    return [...(await unverifiedSealChecks(opened)), ...(await unverifiedRevocationChecks(opened))];
  } catch (error) {
    // A machine that cannot verify says so in a row of its own, which never sets the exit.
    if (isKernelError(error) && error.reason === "tool-unavailable") {
      return [
        {
          name: "attestation-signatures",
          ok: false,
          detail:
            "ssh-keygen reached no verdict on a seal's or a revocation's signature, so none is named unverified here",
        },
      ];
    }
    throw error;
  }
}

/** The command naming what a paste-safe row leaves out. */
function showRemedy(id: RecordId, what: string): string {
  return `\`musai lab attestation show ${shortIdOf(id)}\` names ${what}`;
}

async function unverifiedSealChecks(opened: Workspace): Promise<LocalCheck[]> {
  const unverified: StandingSeal[] = [];
  for (const subject of opened.index.subjectsAttested("sealed")) {
    unverified.push(...(await sealStanding(opened, subject)).standing.filter((seal) => !seal.verified));
  }
  if (unverified.length === 0) {
    return [{ name: "unverified-seals", ok: true, detail: "every seal that stands carries a signature that verifies" }];
  }
  return unverified.map(({ id, record }) => ({
    name: "unverified-seals",
    ok: false,
    detail: `seal ${shortIdOf(id)} over ${shortIdOf(record.subject)} has no signature that verifies and withholds all the same; ${showRemedy(id, "the audience it seals from")}, and sealing that subject again from it (\`musai lab seal ${shortIdOf(record.subject)} --from <audience>${record.seal.extent === "closure" ? " --closure" : ""}\`) signs a seal replacing it, or find what stripped or replaced its signature`,
  }));
}

async function unverifiedRevocationChecks(opened: Workspace): Promise<LocalCheck[]> {
  const withdrawn: RevokedRelease[] = [];
  for (const subject of opened.index.subjectsAttested("released")) {
    const { standing, revoked } = await releaseStanding(opened, subject);
    const replaced = new Set([...standing, ...revoked].flatMap((release) => release.record.supersedes));
    withdrawn.push(...revoked.filter((release) => withdrawnUnverified(release) && !replaced.has(release.id)));
  }
  if (withdrawn.length === 0) {
    return [
      { name: "unverified-revocations", ok: true, detail: "no release is withdrawn by an unverified revocation alone" },
    ];
  }
  const yours = await signingKeyPrincipals(opened, undefined);
  return withdrawn.flatMap((release) => {
    const subject = shortIdOf(release.record.subject);
    const name = withdrawnIn(release, yours);
    const revoke = `revoking it again (\`musai lab revoke ${subject} --to <audience>\`) signs one`;
    const remedy =
      name === "in your name"
        ? revoke
        : `${revoke}, if the revocation is yours, or releasing that subject again to that audience on those terms (\`musai lab release ${subject} --to <audience>\`) replaces the release, if it is not`;
    return release.withdrawnBy.map(({ id }) => ({
      name: "unverified-revocations",
      ok: false,
      detail: `revocation ${shortIdOf(id)}, ${name}, withdraws release ${shortIdOf(release.id)} of ${subject} with no signature that verifies, and withholds it all the same; ${showRemedy(release.id, "the release's audience and terms")}, and ${remedy}`,
    }));
  });
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

interface LoggedCall {
  readonly request: CallLogRequest;
  readonly response: CallLogResponse;
}

/** Undefined for a line that is no entry, such as one a session stopped while writing. */
function loggedCallOf(line: string): LoggedCall | undefined {
  try {
    const { request, response } = JSON.parse(line) as LoggedCall;
    const named = [request.contribution, request.id, request.version].every((field) => typeof field === "string");
    return named && typeof response.ok === "boolean" ? { request, response } : undefined;
  } catch {
    return undefined;
  }
}

async function callLogLines(localDir: string): Promise<string[]> {
  const dir = join(localDir, CALL_LOG_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const texts = await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
  return texts.flatMap((text) => text.split("\n").filter((line) => line !== ""));
}

interface TalliedKind {
  readonly label: string;
  readonly one: string;
  readonly many: string;
}

const TALLIED: Readonly<Record<string, TalliedKind>> = {
  extension: { label: "extension tool", one: "call", many: "calls" },
  subscription: { label: "subscription", one: "run", many: "runs" },
};

/** Counts alone, since a logged value can quote a secret and the report is pasted into an issue. */
async function callLogChecks(localDir: string): Promise<LocalCheck[]> {
  const tallies = new Map<string, { readonly kind: TalliedKind; logged: number; failed: number }>();
  let unreadable = 0;
  for (const line of await callLogLines(localDir)) {
    const call = loggedCallOf(line);
    if (call === undefined) {
      unreadable += 1;
      continue;
    }
    const kind = TALLIED[call.request.contribution];
    if (kind === undefined) {
      continue;
    }
    const version = call.request.contribution === "subscription" ? `@${call.request.version}` : "";
    const label = `${kind.label} ${call.request.id}${version}`;
    const tally = tallies.get(label) ?? { kind, logged: 0, failed: 0 };
    tally.logged += 1;
    tally.failed += call.response.ok ? 0 : 1;
    tallies.set(label, tally);
  }
  const rows: LocalCheck[] = [...tallies]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([label, { kind, logged, failed }]) => ({
      name: "call-log",
      ok: failed === 0,
      detail: `${label}: ${logged} ${logged === 1 ? kind.one : kind.many} logged, ${failed} failed`,
    }));
  if (rows.length === 0) {
    rows.push({
      name: "call-log",
      ok: true,
      detail: "no session's call log holds an extension tool or a subscription",
    });
  }
  if (unreadable > 0) {
    rows.push({
      name: "call-log",
      ok: false,
      detail: `${unreadable} line${unreadable === 1 ? "" : "s"} in the sessions' call logs ${unreadable === 1 ? "does" : "do"} not parse`,
    });
  }
  return rows;
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

/** Always passes: `openWorkspace` already read every trust file whole. */
function trustFilesCheck(): LocalCheck {
  return {
    name: "trust-files",
    ok: true,
    detail: "allowed-signers, roles, audiences and config.json on the trust branch each read whole",
  };
}

function trustFaultCheck(fault: KernelError): LocalCheck {
  return { name: "trust-files", ok: false, detail: fault.detail };
}

/** One failed row per trust-file refusal, for a workspace the open refused over `refusal`. */
export async function trustFileChecks(gitDir: string, refusal: TrustFileError): Promise<readonly LocalCheck[]> {
  // An open refuses config.json before it reads a line file, and a key of it after all read whole.
  if (refusal.line === null) {
    return [trustFaultCheck(refusal)];
  }
  return trustFileFaults(await readTrustBranch({ gitDir })).map(trustFaultCheck);
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

/** One row per view worktree whose slug no case in the fold carries, named by its commit, since
 * its slug, and the path and branch spelling it, may be a sealed case's. */
async function viewWorktreeChecks(opened: Workspace): Promise<LocalCheck[]> {
  const worktrees = await listViewWorktrees(opened.ctx, new Set(opened.index.caseSlugs()));
  const stale = worktrees.filter((worktree) => worktree.stale);
  if (stale.length === 0) {
    return [{ name: "view-worktrees", ok: true, detail: "no stale view worktree" }];
  }
  const list = `in the workspace, \`git --git-dir ${MUSAI_DIR} worktree list --porcelain\``;
  const remove = "and `worktree remove` and `branch -D` under the same `--git-dir` remove it and its branch";
  return stale.map(({ headCommit }) => ({
    name: "view-worktrees",
    ok: false,
    detail:
      headCommit === null
        ? `a view worktree whose branch holds no commit carries a slug no case holds; ${list} lists it as a view/ branch whose HEAD is all zeros, ${remove}`
        : `the view worktree at commit ${headCommit.slice(0, SHORT_ID_LENGTH)} carries a slug no case holds; ${list} names it beside that commit, ${remove}`,
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

/** A run's deadline and its caller's interruption reach a grandchild that left the group only
 * through this table. */
function processTableCheck(): LocalCheck {
  if (process.platform === "win32") {
    return { name: "process-table", ok: true, detail: "`taskkill /T` ends a run's tree by parent link" };
  }
  try {
    readProcessTable();
  } catch (error) {
    if (error instanceof ProcessTableError) {
      return {
        name: "process-table",
        ok: false,
        detail: `${error.detail}: a run's deadline and its caller's interruption end its process group alone, and a grandchild that called setsid outlives them`,
      };
    }
    throw error;
  }
  return {
    name: "process-table",
    ok: true,
    detail: `${PROCESS_TABLE} lists this machine's processes: a run's end reaches a grandchild that left its group`,
  };
}

/** A seal's and a release's checks spawn ssh-keygen at every signing level, `off` included. */
async function sshKeygenCheck(): Promise<LocalCheck> {
  const fault = await sshSigningFault();
  return fault === null
    ? {
        name: "ssh-keygen",
        ok: true,
        detail: "ssh-keygen makes a key, signs and verifies: a seal's or a release's check runs here",
      }
    : {
        name: "ssh-keygen",
        ok: false,
        detail: `ssh-keygen cannot check a signature here (${fault}): a seal's or a release's check refuses whatever the signing level, and so does a cleared open of a workspace holding either; install OpenSSH`,
      };
}

/** Facts about this machine alone, which hold whether or not a workspace opens here. */
export async function machineChecks(): Promise<readonly LocalCheck[]> {
  return [...(await canaryChecks()), await containerEngineCheck(), processTableCheck(), await sshKeygenCheck()];
}

/** The kernel's own half of a receiver's precheck: facts about local state no module declares. */
export async function localChecks(opened: Workspace): Promise<readonly LocalCheck[]> {
  const localDir = join(opened.ctx.gitDir, LOCAL_DIR);
  const forAuthor = opened.clearance === undefined;
  return [
    await keyFileCheck(localDir),
    ...(await bindingsChecks(opened, localDir)),
    await checkoutsFileCheck(localDir),
    await enclosingRepositoryCheck(opened.ctx.gitDir, localDir),
    await blobStoreCheck(opened.ctx.gitDir),
    ...(await initHolderChecks(opened.ctx.gitDir)),
    // The store's record and object counts include what a seal hides from a cleared fold.
    ...(forAuthor ? [await recordLayoutCheck(opened)] : []),
    trustFilesCheck(),
    publishedKeyCheck(opened),
    ...(forAuthor ? [await looseObjectsCheck(opened)] : []),
    // A session's call log is what the machine keeps for its author, sealed records included.
    ...(forAuthor ? await callLogChecks(localDir) : []),
    ...(await machineToolChecks(localDir)),
    indexSchemaCheck(),
    ...contributedDeclarationChecks(opened),
    ...malformedRequirementChecks(opened),
    // A cleared fold lacks the slug of a case sealed from it, which the author's open view names.
    ...(forAuthor ? await viewWorktreeChecks(opened) : []),
    // A forked slot is a fact about records, which doctor under a clearance counts none of.
    ...(forAuthor ? forkedSlotChecks(opened) : []),
    ...(forAuthor ? forkedSlugChecks(opened) : []),
    // A station must not learn that a seal exists.
    ...(forAuthor ? await unverifiedChecks(opened) : []),
    ...(await machineChecks()),
  ];
}
