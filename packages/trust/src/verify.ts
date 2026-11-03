import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelError, type RecordId, type Timestamp } from "@musai/records";
import { execa, type Result } from "execa";
import { opensshEnv, SIGNATURE_NAMESPACE } from "./sign.js";

export type VerifyFailureReason = "signature-invalid" | "not-yet-valid" | "no-longer-valid";

/** A verification's outcome, naming why it failed rather than a bare boolean. */
export interface VerifyResult {
  readonly principal: string;
  readonly good: boolean;
  readonly failureReason?: VerifyFailureReason;
}

/** What a signature check reads of an attestation at any version: whose it says it is, and when. */
export interface SignedAttestation {
  readonly id: RecordId;
  readonly record: { readonly principal: string; readonly at: Timestamp };
}

export interface VerifyAttestationInput {
  readonly attestation: SignedAttestation;
  /** The attestation's stored bytes, never re-canonicalised: a record normalised from an older
   * schema would differ from what was signed. */
  readonly signedBytes: Uint8Array;
  readonly signature: string;
  readonly allowedSignersPath: string;
}

/** An instant in ssh-keygen's `YYYYMMDDHHMMSSZ` form, always in UTC. */
function verifyTimeOf(claimedAt: string): string {
  const instant = new Date(claimedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`not a timestamp an attestation could claim: ${claimedAt}`);
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
    `${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
  );
}

interface BuildVerifyArgsInput {
  readonly allowedSignersPath: string;
  readonly principal: string;
  readonly sigPath: string;
  readonly verifyTime: string;
}

function buildVerifyArgs(input: BuildVerifyArgsInput): string[] {
  return [
    `-Overify-time=${input.verifyTime}`,
    "-Y",
    "verify",
    "-f",
    input.allowedSignersPath,
    "-I",
    input.principal,
    "-n",
    SIGNATURE_NAMESPACE,
    "-s",
    input.sigPath,
  ];
}

/** Bounds one verification, so a hung ssh-keygen refuses the call instead of stalling it. */
const VERIFY_TIME_LIMIT_MS = 60_000;

/** OpenSSH prints this line on stdout, at exit 255, for every verdict against a signature, from
 * the first release with `-Y verify` (8.1) on. */
const VERDICT = /^Could not verify signature\.$/m;

/** Faults OpenSSH reports on stderr beside that line though it never judged the signature. */
const NO_JUDGEMENT = /Unable to open allowed keys file|Couldn't read signature file/;

/** What OpenSSH says of an allowed-signers line it read and judged the signature by. */
const LINE_VERDICTS = [
  "key is not permitted for use in signature namespace",
  "key is not yet valid",
  "key has expired",
  "certificate not authorized",
  "no valid principals found",
];

/** OpenSSH's `<path>:<line>:` diagnostic for a line it could not read, and so judged nothing by. */
function unreadLine(stderr: string, path: string): string | undefined {
  return stderr.split("\n").find((said) => {
    if (!said.startsWith(`${path}:`)) {
      return false;
    }
    const diagnostic = /^\d+: (.*)$/.exec(said.slice(path.length + 1));
    return diagnostic === null || !LINE_VERDICTS.some((verdict) => diagnostic[1]!.startsWith(verdict));
  });
}

/** OpenSSH's line on stdout, at exit 0, for a good signature by `principal` under our namespace. */
function vouches(stdout: string, principal: string): boolean {
  const good = `Good "${SIGNATURE_NAMESPACE}" signature for ${principal} with `;
  return stdout.split("\n").some((line) => line.startsWith(good));
}

interface Answer {
  readonly result: Result;
  readonly principal: string;
  readonly allowedSignersPath: string;
  readonly stdout: string;
  readonly stderr: string;
}

function textOf(output: Result["stdout"]): string {
  return Array.isArray(output) ? output.join("\n") : String(output ?? "");
}

/** Why ssh-keygen gave no exit status of its own, or null where it did. */
function unfinished(result: Result): string | null {
  if (result.timedOut) {
    return `it ran past its ${VERIFY_TIME_LIMIT_MS} ms limit and was ended`;
  }
  if (result.signal !== undefined) {
    return `it was ended by ${result.signal}`;
  }
  if (result.exitCode === undefined) {
    return `it did not start (${result.code ?? "no exit code"})`;
  }
  return null;
}

function unjudged({ result, principal, allowedSignersPath, stdout, stderr }: Answer): string | null {
  const stopped = unfinished(result);
  if (stopped !== null) {
    return stopped;
  }
  if (result.exitCode === 0) {
    return vouches(stdout, principal) ? null : `it exited 0 without vouching for ${principal}`;
  }
  const unread = unreadLine(stderr, allowedSignersPath);
  if (result.exitCode !== 255 || !VERDICT.test(stdout) || NO_JUDGEMENT.test(stderr) || unread !== undefined) {
    const said = unread ?? stderr.trim().split("\n")[0];
    return `it exited ${result.exitCode} without a verdict${said ? `: ${said}` : ""}`;
  }
  return null;
}

/** A missing allowed-signers file is this machine's fault, never a verdict on a signature. */
async function refuseMissingSigners(attestation: SignedAttestation, path: string): Promise<void> {
  if ((await stat(path).catch(() => null))?.isFile() === true) {
    return;
  }
  throw new KernelError({
    reason: "workspace-incomplete",
    about: [attestation.id],
    detail: `attestation ${attestation.id} cannot be verified: the allowed signers file ${path} is missing or not a file, and opening the workspace again writes it`,
  });
}

function classifyFailure(stderr: string): VerifyFailureReason {
  if (/is not yet valid/.test(stderr)) {
    return "not-yet-valid";
  }
  if (/has expired/.test(stderr)) {
    return "no-longer-valid";
  }
  return "signature-invalid";
}

/** Verifies a sidecar at its attestation's claimed time, so a key rotated out later keeps history;
 * a check reaching no verdict refuses, so no fault reads as a bad signature. */
export async function verifyAttestation(input: VerifyAttestationInput): Promise<VerifyResult> {
  const principal = input.attestation.record.principal;
  const verifyTime = verifyTimeOf(input.attestation.record.at);
  const messageBytes = input.signedBytes;

  await refuseMissingSigners(input.attestation, input.allowedSignersPath);
  const tmpDir = await mkdtemp(join(tmpdir(), "musai-verify-"));
  try {
    const sigPath = join(tmpDir, "attestation.sig");
    await writeFile(sigPath, input.signature);

    const args = buildVerifyArgs({
      allowedSignersPath: input.allowedSignersPath,
      principal,
      sigPath,
      verifyTime,
    });

    const result = await execa("ssh-keygen", args, {
      env: opensshEnv(),
      extendEnv: false,
      input: messageBytes,
      reject: false,
      timeout: VERIFY_TIME_LIMIT_MS,
    });

    const stderrText = textOf(result.stderr);
    const stdoutText = textOf(result.stdout);
    const fault = unjudged({
      result,
      principal,
      allowedSignersPath: input.allowedSignersPath,
      stdout: stdoutText,
      stderr: stderrText,
    });
    if (fault !== null) {
      throw new KernelError({
        reason: "tool-unavailable",
        about: [input.attestation.id],
        detail: `ssh-keygen could not verify attestation ${input.attestation.id}: ${fault}`,
      });
    }
    if (result.exitCode === 0) {
      return { principal, good: true };
    }
    return { principal, good: false, failureReason: classifyFailure(stderrText) };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const PROBE_PRINCIPAL = "musai-doctor-probe";

/** Any instant serves, since the probe's key has no validity window. */
const PROBE_VERIFY_TIME = "20260101000000Z";

/** What stops this machine's ssh-keygen making a key, signing and verifying as a check does, or
 * null where nothing does. */
export async function sshSigningFault(): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "musai-ssh-probe-"));
  try {
    // A scratch path would make two reports at one head differ.
    return (await probeIn(dir))?.replaceAll(dir, "<scratch>") ?? null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeIn(dir: string): Promise<string | null> {
  const run = (args: readonly string[], input: string = "") =>
    execa("ssh-keygen", args, {
      env: opensshEnv(),
      extendEnv: false,
      input,
      reject: false,
      timeout: VERIFY_TIME_LIMIT_MS,
    });
  const failed = (step: string, result: Result): string | null => {
    const stopped = unfinished(result) ?? (result.exitCode === 0 ? null : `it exited ${result.exitCode}`);
    const said = textOf(result.stderr).trim().split("\n")[0];
    return stopped === null ? null : `${step}: ${stopped}${said ? `: ${said}` : ""}`;
  };
  const keyPath = join(dir, "key");
  const messagePath = join(dir, "message");
  const allowedSignersPath = join(dir, "allowed-signers");
  const made = await run(["-q", "-t", "ed25519", "-N", "", "-C", PROBE_PRINCIPAL, "-f", keyPath]);
  const unmade = failed("making a key", made);
  if (unmade !== null) {
    return unmade;
  }
  await writeFile(messagePath, PROBE_PRINCIPAL);
  const unsigned = failed("signing", await run(["-Y", "sign", "-f", keyPath, "-n", SIGNATURE_NAMESPACE, messagePath]));
  if (unsigned !== null) {
    return unsigned;
  }
  const [keyType, key] = (await readFile(`${keyPath}.pub`, "utf8")).trim().split(/\s+/);
  await writeFile(allowedSignersPath, `${PROBE_PRINCIPAL} ${keyType} ${key}\n`);
  const args = buildVerifyArgs({
    allowedSignersPath,
    principal: PROBE_PRINCIPAL,
    sigPath: `${messagePath}.sig`,
    verifyTime: PROBE_VERIFY_TIME,
  });
  const result = await run(args, PROBE_PRINCIPAL);
  const stdout = textOf(result.stdout);
  const stderr = textOf(result.stderr);
  const fault = unjudged({ result, principal: PROBE_PRINCIPAL, allowedSignersPath, stdout, stderr });
  if (fault !== null) {
    return `verifying: ${fault}`;
  }
  return result.exitCode === 0 ? null : "verifying: it judged a signature it had just made bad";
}
