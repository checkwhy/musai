import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type OperationDescriptor, openWorkspace } from "@musai/api-core";
import { hexOfRecordId, isKernelError, KernelError, rawId, versionString } from "@musai/records";
import { readBlobDirectory } from "../blob-dir.js";

export interface BlobImportInput {
  readonly dir: string;
}

export interface BlobImportOutput {
  readonly put: number;
  readonly held: number;
}

/** `blobs.import@1`: puts every blob of a directory store on the store's blobs branch, or none. */
export const blobImport: OperationDescriptor<BlobImportInput, BlobImportOutput> = {
  id: "blobs.import",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["dir"],
    properties: { dir: { type: "string", minLength: 1 } },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["put", "held"],
    properties: { put: { type: "integer" }, held: { type: "integer" } },
  },
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["invalid-input"],
  documentation:
    "Puts every blob of a directory laid out as <xx>/<hex> on the store's blobs branch, refusing them all if one does not digest to its name.",
  paths: ["dir"],
  cli: {
    verb: "import",
    group: "blobs",
    positional: ["dir"],
    flags: [],
    describe: "move a blob directory onto the store's blobs branch; the directory is left for you to remove",
  },
  renderText: (output) =>
    `put ${output.put} blob${output.put === 1 ? "" : "s"} on the store's blobs branch; ${output.held} ${output.held === 1 ? "was" : "were"} already there`,
  exitCode: () => 0,
  async handler(input, context) {
    const dir = resolve(context.workspace, input.dir);
    const directory = await readBlobDirectory(dir);
    if (directory === null || directory.strays.length > 0) {
      throw new KernelError({
        reason: "invalid-input",
        detail:
          directory === null
            ? `${dir} does not exist`
            : `${dir} holds entries outside a blob store's <xx>/<hex> layout, so nothing was imported: ${directory.strays.join(", ")}`,
        about: [dir],
      });
    }
    const blobs = await Promise.all(
      directory.files.map(async (file) => ({ ...file, bytes: new Uint8Array(await readFile(file.path)) })),
    );
    const mismatched = blobs.filter((blob) => hexOfRecordId(rawId(blob.bytes)) !== blob.hex).map((blob) => blob.path);
    if (mismatched.length > 0) {
      throw new KernelError({
        reason: "invalid-input",
        detail: `these files' bytes do not digest to their names, so nothing was imported: ${mismatched.join(", ")}`,
        about: mismatched,
      });
    }
    const opened = await openWorkspace({ ...context, reportRefusal: undefined });
    let held = 0;
    for (const blob of blobs) {
      try {
        await opened.blobs.read(rawId(blob.bytes));
        held += 1;
      } catch (error) {
        if (!isKernelError(error) || error.reason !== "no-such-record") {
          throw error;
        }
        if (context.mode !== "plan") {
          await opened.blobs.put(blob.bytes);
        }
      }
    }
    return { put: blobs.length - held, held };
  },
};
