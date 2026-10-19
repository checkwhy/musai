import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { canonicalBytes, isKernelError, type KernelError } from "@musai/records";

/** What a refusal says on the wire, whether in a tool result's text or a JSON-RPC error's data. */
function refusalBody(error: KernelError): { reason: string; about: readonly string[]; detail: string } {
  return { reason: error.reason, about: error.about, detail: error.detail };
}

export function refusalText(error: KernelError): string {
  return new TextDecoder().decode(canonicalBytes(refusalBody(error)));
}

/** MCP gives a list, a resource read and a prompt no error result, so a refusal there crosses as a
 * JSON-RPC error with the refusal in `data`; a plain `Error` spares the SDK's double prefix. */
export async function refusalCrossingAsRpcError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isKernelError(error)) {
      throw error;
    }
    throw Object.assign(new Error(error.detail), { code: ErrorCode.InternalError, data: refusalBody(error) });
  }
}
