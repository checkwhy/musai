import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalBytes } from "@musai/records";
import { readBindings, secretObservation } from "@musai/run";
import {
  CALL_LOG_DIR,
  currentKey,
  LOCAL_DIR,
  listKeys,
  MUSAI_DIR,
  readKeyFile,
  type WorkspaceKey,
  workspaceAbsent,
} from "@musai/store";

function callLogDirPath(workspaceDir: string): string {
  return join(workspaceDir, MUSAI_DIR, LOCAL_DIR, CALL_LOG_DIR);
}

/** Where the bindings and keys that never leave the machine are kept. */
export function workspaceLocalDir(workspaceDir: string): string {
  return join(workspaceDir, MUSAI_DIR, LOCAL_DIR);
}

/** Holds no workspace yet, so no log, event or installed contribution: `init` makes one there. */
export function noWorkspaceAt(workspaceDir: string): Promise<boolean> {
  return workspaceAbsent(join(workspaceDir, MUSAI_DIR));
}

/** Names only, so no credential helper runs for the sake of a check. */
export async function secretBindingNames(workspaceDir: string): Promise<readonly string[]> {
  const bindings = await readBindings(workspaceLocalDir(workspaceDir));
  return Object.entries(bindings)
    .filter(([, source]) => source.secret)
    .map(([name]) => name);
}

/** A file one session alone appends to; two sessions never share one. */
export interface CallLog {
  readonly path: string;
}

async function mkdirIfAbsent(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/** A session's trace stays on this machine: nothing in the record store is handed this path. */
export async function openCallLog(workspaceDir: string): Promise<CallLog> {
  const dir = callLogDirPath(workspaceDir);
  // Made below `.musai` alone, so a workspace removed meanwhile is not made again as its parent.
  await mkdirIfAbsent(workspaceLocalDir(workspaceDir));
  await mkdirIfAbsent(dir);
  await chmod(dir, 0o700);
  const name = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.jsonl`;
  const path = join(dir, name);
  // Made at open, so the file stands for the workspace that holds it before any entry lands.
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return { path };
}

/** `contribution` is `"operation"`, `"extension"`, `"subscription"`, `"fold"` (id: the file) or a
 * contribution kind; a call refused before its tool resolves is `"operation"` at version `"0"`. */
export interface CallLogRequest {
  readonly contribution: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
}

/** The envelope's two-way shape; `code` is wide enough for a contribution's error code and an
 * operation's reason alike. */
export type CallLogResponse =
  | { readonly ok: true; readonly output: unknown; readonly diagnostics: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly data: unknown; readonly message: string } };

/** Literal values only: resolving a `command` binding would run a credential helper as a side
 * effect of a passive log. */
async function secretValuesByLiteral(workspaceDir: string): Promise<ReadonlyMap<string, string>> {
  const bindings = await readBindings(workspaceLocalDir(workspaceDir));
  const byValue = new Map<string, string>();
  for (const [name, source] of Object.entries(bindings)) {
    if (source.secret && source.value !== undefined) {
      byValue.set(source.value, name);
    }
  }
  return byValue;
}

async function currentWorkspaceKeyOrNull(workspaceDir: string): Promise<WorkspaceKey | null> {
  const localDir = workspaceLocalDir(workspaceDir);
  const keys = await listKeys(localDir);
  if (keys.length === 0) {
    return null;
  }
  return currentKey(await readKeyFile(localDir));
}

type SecretReplacer = (name: string, value: string) => unknown;

/** The keyed hash a receipt would carry; before the workspace has a key, the binding's name alone,
 * since a passive log mints no key. */
function secretReplacer(key: WorkspaceKey | null): SecretReplacer {
  return key === null ? (name) => ({ name, secret: true }) : (name, value) => secretObservation(key, name, value);
}

/** Matches whole values anywhere in the tree; a secret inside a longer string is not found. */
function scrubKnownSecrets(value: unknown, byValue: ReadonlyMap<string, string>, replace: SecretReplacer): unknown {
  if (typeof value === "string") {
    const name = byValue.get(value);
    return name === undefined ? value : replace(name, value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubKnownSecrets(entry, byValue, replace));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        scrubKnownSecrets(entryValue, byValue, replace),
      ]),
    );
  }
  return value;
}

/** Prose fields are scrubbed too, since prose is where a handed-in value comes back out. */
function scrubResponse(
  response: CallLogResponse,
  byValue: ReadonlyMap<string, string>,
  replace: SecretReplacer,
): CallLogResponse {
  if (response.ok) {
    return {
      ok: true,
      output: scrubKnownSecrets(response.output, byValue, replace),
      diagnostics: scrubKnownSecrets(response.diagnostics, byValue, replace),
    };
  }
  return {
    ok: false,
    error: {
      code: response.error.code,
      data: scrubKnownSecrets(response.error.data, byValue, replace),
      message: scrubKnownSecrets(response.error.message, byValue, replace) as string,
    },
  };
}

/** Read as each entry is written, so a call that makes the workspace lands in the log it makes. */
export type CallLogSource = () => Promise<CallLog | undefined>;

export async function logCall(
  source: CallLogSource,
  workspaceDir: string,
  request: CallLogRequest,
  response: CallLogResponse,
): Promise<void> {
  const log = await source();
  if (log !== undefined) {
    await appendCall(log, workspaceDir, request, response);
  }
}

/** Logs a secret as a receipt represents one, matched whole-value, so no logged value is a
 * secret though a logged sentence may quote one. */
export async function appendCall(
  log: CallLog,
  workspaceDir: string,
  request: CallLogRequest,
  response: CallLogResponse,
): Promise<void> {
  const byValue = await secretValuesByLiteral(workspaceDir);
  let loggedRequest = request;
  let loggedResponse = response;
  if (byValue.size > 0) {
    const replace = secretReplacer(await currentWorkspaceKeyOrNull(workspaceDir));
    loggedRequest = { ...request, input: scrubKnownSecrets(request.input, byValue, replace) };
    loggedResponse = scrubResponse(response, byValue, replace);
  }
  const line = { request: loggedRequest, response: loggedResponse };
  const bytes = canonicalBytes(line);
  await appendFile(log.path, `${new TextDecoder().decode(bytes)}\n`, { mode: 0o600 });
}
