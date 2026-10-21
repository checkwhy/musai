import {
  lookupOperation,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  runHandler,
} from "@musai/api-core";
import type { McpResources, ReadResourceResult } from "@musai/mcp";
import { canonicalBytes, versionString } from "@musai/records";
import { findCaseRecord } from "../cases.js";
import { artifactsOf, renderDossier } from "../view/render.js";

/** Everything after the prefix is the slug, unparsed, since a slug may hold URI delimiters. */
const CASE_URI_PREFIX = "case://";
const CASE_URI_TEMPLATE = `${CASE_URI_PREFIX}{slug}`;

/** Everything after the prefix is the slot, unparsed, so a URI-shaped slot stays one slot. */
const CLAIM_URI_PREFIX = "claim://";
const CLAIM_URI_TEMPLATE = `${CLAIM_URI_PREFIX}{slot}`;

const PENDING_GATES_URI = "gates://pending";

function textContents(uri: string, mimeType: string, text: string): ReadResourceResult["contents"][number] {
  return { uri, mimeType, text };
}

async function readCaseResource(uri: string, slug: string, context: OperationContext): Promise<ReadResourceResult> {
  const opened = await openWorkspace(context);
  const found = await findCaseRecord(opened, slug);
  if (found === null) {
    throw new OperationError({ reason: "no-such-record", about: [uri], detail: `no case named ${slug}` });
  }
  const artifacts = await artifactsOf(opened, found.id);
  const dossier = await renderDossier(opened, found.id, found.record, artifacts);
  return { contents: [textContents(uri, "text/markdown", dossier)] };
}

async function readClaimResource(
  uri: string,
  slot: string,
  registry: ReadonlyMap<string, OperationDescriptor>,
  context: OperationContext,
): Promise<ReadResourceResult> {
  const claimStatus = lookupOperation(registry, "claim.status", versionString("3"));
  const output = await runHandler(claimStatus, { claim: slot }, context);
  return { contents: [textContents(uri, "application/json", new TextDecoder().decode(canonicalBytes(output)))] };
}

async function readPendingGatesResource(
  uri: string,
  registry: ReadonlyMap<string, OperationDescriptor>,
  context: OperationContext,
): Promise<ReadResourceResult> {
  const gatePending = lookupOperation(registry, "gate.pending", versionString("1"));
  const output = await runHandler(gatePending, {}, context);
  return { contents: [textContents(uri, "application/json", new TextDecoder().decode(canonicalBytes(output)))] };
}

/** Resolves a resource URI to its content; one naming nothing real is refused, never an empty
 * document, since an absent case and an empty dossier are different facts. */
async function readResource(
  registry: ReadonlyMap<string, OperationDescriptor>,
  context: OperationContext,
  uri: string,
): Promise<ReadResourceResult> {
  if (uri === PENDING_GATES_URI) {
    return readPendingGatesResource(uri, registry, context);
  }
  if (uri.startsWith(CASE_URI_PREFIX)) {
    return readCaseResource(uri, uri.slice(CASE_URI_PREFIX.length), context);
  }
  if (uri.startsWith(CLAIM_URI_PREFIX)) {
    return readClaimResource(uri, uri.slice(CLAIM_URI_PREFIX.length), registry, context);
  }
  throw new OperationError({ reason: "no-such-record", about: [uri], detail: `no resource named ${uri}` });
}

export const MUSAI_RESOURCES: McpResources = {
  resources: [{ uri: PENDING_GATES_URI, name: "pending gates", mimeType: "application/json" }],
  templates: [
    { uriTemplate: CASE_URI_TEMPLATE, name: "case", mimeType: "text/markdown" },
    { uriTemplate: CLAIM_URI_TEMPLATE, name: "claim", mimeType: "application/json" },
  ],
  read: (session, uri) => readResource(session.distribution.registry, session.context, uri),
};
