import { resolve } from "node:path";
import { NO_PRINCIPAL_REMEDY, type OperationContext, type OperationDescriptor, OperationError } from "@musai/api-core";
import { IndexDb } from "@musai/fold";
import { versionString } from "@musai/records";
import { GitBlobStore, type GitContext, initWorkspace, readTrustBranch, Store, writeMainFiles } from "@musai/store";
import { keyPrincipalOf, publicKeyBeside, SIGNATURE_NAMESPACE, writeSignerConfig } from "@musai/trust";
import { installDistributionModule, readDistributionArtefacts } from "../distribution.js";

export interface WorkspaceInitInput {
  /** The surface's own workspace when absent: the current directory, on the command line. */
  readonly workspace?: string;
  /** A private key whose `.pub` sits beside it, as `ssh-keygen` writes a pair. */
  readonly key?: string;
}

export interface Registration {
  /** The key as every record and the roles file name it. */
  readonly principal: string;
  /** The alias allowed-signers lists beside the key, for display; `null` where none was given. */
  readonly name: string | null;
  readonly key: string;
}

export interface WorkspaceInitOutput {
  readonly gitDir: string;
  readonly registered: Registration | null;
}

function renderInitText(output: WorkspaceInitOutput): string {
  const registration =
    output.registered === null
      ? `no signing key named, so every role is anyone's; to attest, ${NO_PRINCIPAL_REMEDY}`
      : `registered ${output.registered.name === null ? output.registered.principal : `${output.registered.name} (${output.registered.principal})`} as owner, signing with ${output.registered.key}`;
  return `${output.gitDir}\n${registration}`;
}

function refuseRegistration(detail: string, about: string): OperationError {
  return new OperationError({ reason: "invalid-input", about: [about], detail });
}

/** The operator's key as the trust files will hold it. */
interface OperatorKey {
  readonly principal: string;
  readonly name: string | null;
  readonly keyPath: string;
  readonly publicKey: string;
}

/** OpenSSH splits an allowed-signers principal list on commas and the roles file on whitespace;
 * a key's and a pseudonym's forms are a principal's own, never an alias. */
const PRINCIPAL_NAME = /^(?!key:|pseudonym:)[^\s,"]+$/;

/** Read and checked before anything is created, so a refusal leaves no workspace behind. */
async function operatorKey(key: string, context: OperationContext): Promise<OperatorKey> {
  const name = context.principalName ?? null;
  if (name !== null && !PRINCIPAL_NAME.test(name)) {
    throw refuseRegistration(
      `refusing to register ${key} for ${JSON.stringify(name)}: a name the trust files list holds no whitespace, comma or quote and is spelled as no key or pseudonym; set MUSAI_PRINCIPAL to one that is not`,
      name,
    );
  }
  const keyPath = resolve(key);
  const publicKey = await publicKeyBeside(keyPath);
  if (publicKey === null) {
    throw refuseRegistration(
      `refusing to register ${keyPath}: no key pair ssh-keygen reads is there, a private key with its public half at ${keyPath}.pub`,
      keyPath,
    );
  }
  return { principal: keyPrincipalOf(publicKey), name, keyPath, publicKey };
}

/** Writes the operator's key and owner role on the trust branch, only while both files are empty,
 * so a workspace already naming its signers is never rewritten from here. */
async function registerOperator(
  ctx: GitContext,
  localDir: string,
  operator: OperatorKey,
  context: OperationContext,
): Promise<Registration> {
  const { principal, name, keyPath, publicKey } = operator;
  const trust = await readTrustBranch(ctx);
  if (trust.allowedSigners.trim().length > 0 || trust.roles.trim().length > 0) {
    throw refuseRegistration(
      `refusing to register ${principal}: this workspace's trust branch already names its signers or roles; edit allowed-signers and roles on main instead`,
      principal,
    );
  }
  await writeMainFiles(
    ctx,
    {
      "allowed-signers": `${name === null ? principal : `${name},${principal}`} namespaces="${SIGNATURE_NAMESPACE}" ${publicKey}\n`,
      roles: `${principal} owner any\n`,
    },
    context.now,
  );
  await writeSignerConfig(localDir, { keyPath });
  return { principal, name, key: keyPath };
}

/** `workspace.init@1`: creates a workspace, or reports the existing one, which gains `local/` and
 * its collection settings; either gets the core module installed unless it already holds one. */
export const workspaceInit: OperationDescriptor<WorkspaceInitInput, WorkspaceInitOutput> = {
  id: "workspace.init",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace: { type: "string" },
      key: { type: "string", minLength: 1 },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["gitDir", "registered"],
    properties: {
      gitDir: { type: "string" },
      registered: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["principal", "name", "key"],
            properties: {
              principal: { type: "string" },
              name: { type: ["string", "null"] },
              key: { type: "string" },
            },
          },
        ],
      },
    },
  },
  effect: "write",
  authority: null,
  plans: false,
  reasons: ["head-moved", "no-such-record", "invalid-input"],
  documentation:
    "Creates a workspace, or installs the core module into one that holds none, refusing before any key is registered if it conflicts with an installed module; registers the operator's signing key when one is named.",
  paths: ["workspace", "key"],
  cli: {
    verb: "init",
    positional: ["workspace"],
    flags: ["key"],
    describe: "create a workspace, registering the operator's signing key when one is named",
  },
  renderText: renderInitText,
  exitCode: () => 0,
  async handler(input, context) {
    // Read first: an unbuilt distribution must be refused before a workspace exists to be reported.
    const artefacts = await readDistributionArtefacts();
    const operator = input.key === undefined ? null : await operatorKey(input.key, context);
    const result = await initWorkspace(input.workspace ?? context.workspace, { now: context.now });

    const ctx = { gitDir: result.gitDir };
    const store = new Store({ ctx, scope: context.scope, now: context.now });
    const index = new IndexDb(":memory:");
    try {
      await index.fold(store);
      // A workspace that holds a core module keeps it pinned, whichever build it came from.
      if (!index.installedModuleRecords().some((installed) => installed.name === artefacts.name)) {
        await installDistributionModule(artefacts, store, new GitBlobStore({ ctx, now: context.now }), index);
      }
    } finally {
      index.close();
    }

    const registered =
      operator === null ? null : await registerOperator({ gitDir: result.gitDir }, result.localDir, operator, context);
    return { gitDir: result.gitDir, registered };
  },
};
