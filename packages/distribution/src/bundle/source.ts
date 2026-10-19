import { readFile } from "node:fs/promises";
import { OperationError } from "@musai/api-core";
import { MAX_BUNDLE_BYTES, untarGz } from "../export/untar.js";

export type Fetcher = (url: string) => Promise<Response>;

function refused(source: string, detail: string): OperationError {
  return new OperationError({ reason: "invalid-input", about: [source], detail });
}

/** Over https alone, since a bundle fetched in the clear could be swapped on the way. */
async function fetched(url: string, fetcher: Fetcher): Promise<Uint8Array> {
  if (!url.startsWith("https://")) {
    throw refused(url, `refusing to fetch ${url}: a bundle is fetched over https only`);
  }
  const response = await fetcher(url);
  if (!response.ok) {
    throw refused(url, `refusing ${url}: it answered ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BUNDLE_BYTES) {
    throw refused(url, `refusing ${url}: it declares ${declared} bytes, more than ${MAX_BUNDLE_BYTES}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BUNDLE_BYTES) {
    throw refused(url, `refusing ${url}: it sent more than ${MAX_BUNDLE_BYTES} bytes`);
  }
  return bytes;
}

/** A bundle's files, from a `.tar.gz` on disk or at a URL. */
export async function readBundle(source: string, fetcher: Fetcher = fetch): Promise<Map<string, Uint8Array>> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return untarGz(await fetched(source, fetcher));
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(source));
  } catch (error) {
    throw refused(
      source,
      `refusing ${source}: it could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    );
  }
  return untarGz(bytes);
}
