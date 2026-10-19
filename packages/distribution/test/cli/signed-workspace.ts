import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSAI_DIR } from "@musai/store";
import { allowedSignersLine, fixWorkspaceKey, type TestKey, writeTrustFile } from "@musai/test-support";
import { type ExecaError, execa } from "execa";

export const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

/** A workspace whose allowed signers register one key, under a roles file and a signing level. */
export interface SignedWorkspace {
  readonly dir: string;
  readonly gitDir: string;
}

/** What `musai` answered: its exit code, stdout and stderr, whether or not it succeeded. */
export interface Answer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fresh workspace registering `key`, with `roles` as its roles file and `signing` as its level.
 * */
export async function signedWorkspace(
  name: string,
  key: TestKey,
  roles: string,
  signing = "person",
): Promise<SignedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), `musai-${name}-`));
  await execa("node", [CLI_PATH, "init", dir]);
  await fixWorkspaceKey(dir);
  const gitDir = join(dir, MUSAI_DIR);
  await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
  await writeTrustFile({ gitDir }, "roles", roles);
  await writeTrustFile({ gitDir }, "config.json", JSON.stringify({ signing }));
  return { dir, gitDir };
}

/** Runs `musai` against a workspace as `principal` at `now`, answering whatever it exits with. */
export async function musai(
  workspace: SignedWorkspace,
  args: readonly string[],
  env: { readonly principal?: string; readonly now?: string } = {},
): Promise<Answer> {
  try {
    const answered = await execa("node", [CLI_PATH, "--workspace", workspace.dir, ...args], {
      env: {
        ...(env.principal === undefined ? {} : { MUSAI_PRINCIPAL: env.principal }),
        ...(env.now === undefined ? {} : { MUSAI_NOW: env.now }),
      },
    });
    return { exitCode: 0, stdout: answered.stdout, stderr: answered.stderr };
  } catch (error) {
    const failed = error as ExecaError;
    return { exitCode: failed.exitCode ?? -1, stdout: String(failed.stdout), stderr: String(failed.stderr) };
  }
}

/** Runs `musai ... --json` and parses what it answered, failing loudly on a refusal. */
export async function musaiJson<T>(
  workspace: SignedWorkspace,
  args: readonly string[],
  env: { readonly principal?: string; readonly now?: string } = {},
): Promise<T> {
  const answered = await musai(workspace, [...args, "--json"], env);
  if (answered.exitCode !== 0) {
    throw new Error(`musai ${args.join(" ")} exited ${answered.exitCode}: ${answered.stderr}${answered.stdout}`);
  }
  return JSON.parse(answered.stdout) as T;
}

/** A ruling over a booked case's claim, with the claim, the brief it was decided against and who
 * made it. */
export interface Ruled {
  readonly claim: string;
  readonly brief: string;
  readonly ruling: string;
  readonly made: string;
}

/** Books a case, renders its claim's brief and rules on it, signed with `key`. */
export async function bookAndRule(workspace: SignedWorkspace, slug: string, key: TestKey): Promise<Ruled> {
  const booked = await musaiJson<{ minted: { id: string; kind: string }[] }>(workspace, [
    "lab",
    "book",
    slug,
    "--about",
    "https://example.invalid/released",
  ]);
  const claim = booked.minted.find((item) => item.kind === "claim")!.id;
  const { brief } = await musaiJson<{ brief: string }>(workspace, ["lab", "brief", claim]);
  const ruled = await musaiJson<{ minted: { id: string; kind: string }[] }>(workspace, [
    "lab",
    "rule",
    claim,
    "--verdict",
    "holds",
    "--reason",
    "released with its evidence",
    "--brief",
    brief,
    "--key",
    key.keyPath,
  ]);
  const ruling = ruled.minted.find((item) => item.kind === "ruling")!.id;
  const made = ruled.minted.find((item) => item.kind === "attestation")!.id;
  return { claim, brief, ruling, made };
}
