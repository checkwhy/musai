import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchRecipe, RecordId } from "@musai/records";
import { BLOB_THRESHOLD_CONFIG_KEY, canonicalBytes } from "@musai/records";
import { initWorkspace } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { FetchRefusedError, type FetchStore, performFetch } from "../src/fetch.js";
import { RunRefusedError } from "../src/hygiene.js";
import { refuseCredentialIn } from "../src/secrets.js";

const FETCH_NOW = fixedClock("2026-01-01T00:00:00.000Z");

async function withWorkspace<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-fetch-bindings-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBindings(localDir: string, content: unknown): Promise<void> {
  const path = join(localDir, "bindings.json");
  await writeFile(path, JSON.stringify(content));
  await chmod(path, 0o600);
}

async function withStore<T>(fn: (store: FetchStore) => Promise<T>): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "musai-fetch-store-"));
  try {
    await initWorkspace(workspaceDir, { now: FETCH_NOW });
    return await fn({ blobs: blobStoreOf(workspaceDir), config: {} });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function withServer<T>(handler: RequestListener, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the test server to bind a numeric port");
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Bound once then released, so a connection to it is refused rather than timing out. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function recipeFor(locator: string, overrides: Partial<FetchRecipe> = {}): FetchRecipe {
  return { locator, headers: [], names: [], ...overrides };
}

function respond(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

describe("performFetch: a citation is a run whose recipe is the locator and whose observation is what came back", () => {
  test("a small body becomes the run's output and its digest resolves the locator", async () => {
    const body = "a small retrieved body";
    await withServer(
      (_req, res) => respond(res, 200, { "content-type": "text/plain" }, body),
      async (baseUrl) => {
        await withStore(async (store) => {
          const locator = `${baseUrl}/small`;
          const { record } = await performFetch(recipeFor(locator), {}, store, { now: FETCH_NOW });

          expect(record.kind).toBe("run");
          expect(record.runKind).toBe("citation");
          expect(record.recipe.substrates).toEqual([{ uri: locator }]);
          expect(record.observation.exitCode).toBe(200);
          expect(record.observation.output).toBe(body);
          expect(record.observation.resolved).toHaveLength(1);
          expect(record.observation.resolved[0]!.uri).toBe(locator);
          expect(record.observation.resolved[0]!.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
        });
      },
    );
  });

  test("a small body and an oversized body of the same bytes produce the same content digest, one as output and one as a blob reference", async () => {
    const body = "identical retrieval bytes, present in both a small and an oversized run";
    await withServer(
      (_req, res) => respond(res, 200, { "content-type": "text/plain" }, body),
      async (baseUrl) => {
        await withStore(async (store) => {
          const locator = `${baseUrl}/body`;
          const inline = await performFetch(recipeFor(locator), {}, store, { now: FETCH_NOW });
          const overThreshold = await performFetch(
            recipeFor(locator),
            {},
            { ...store, config: { [BLOB_THRESHOLD_CONFIG_KEY]: 1 } },
            { now: FETCH_NOW },
          );

          expect(inline.record.observation.output).toBe(body);
          expect(overThreshold.record.observation.output).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(inline.record.observation.resolved[0]!.digest).toEqual(
            overThreshold.record.observation.resolved[0]!.digest,
          );

          const blobId = overThreshold.record.observation.output as RecordId;
          expect(new TextDecoder().decode(await store.blobs!.read(blobId))).toBe(body);
        });
      },
    );
  });

  test("a body over the threshold, with no blob store handed in, is refused rather than written anywhere", async () => {
    await withServer(
      (_req, res) => respond(res, 200, { "content-type": "text/plain" }, "a body over a one-byte threshold"),
      async (baseUrl) => {
        const refusal = await performFetch(
          recipeFor(`${baseUrl}/body`),
          {},
          { config: { [BLOB_THRESHOLD_CONFIG_KEY]: 1 } },
          { now: FETCH_NOW },
        ).then(
          () => expect.unreachable("a body with nowhere to be held was accepted"),
          (error: unknown) => error,
        );

        expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [`${baseUrl}/body`] });
      },
    );
  });

  test("a redirect response is refused naming the declared locator and the address it was asked to move to", async () => {
    await withServer(
      (_req, res) => respond(res, 302, { location: "http://example.invalid/elsewhere" }, ""),
      async (baseUrl) => {
        await withStore(async (store) => {
          const locator = `${baseUrl}/redirect`;
          try {
            await performFetch(recipeFor(locator), {}, store, { now: FETCH_NOW });
            throw new Error("expected performFetch to refuse the redirect");
          } catch (error) {
            expect(error).toBeInstanceOf(FetchRefusedError);
            expect((error as Error).message).toContain(locator);
            expect((error as Error).message).toContain("example.invalid");
          }
        });
      },
    );
  });

  test("a declared header bound to a secret is sent as its value, recorded as a keyed hash, and never as the value itself", async () => {
    const secretValue = "shh-fetch-secret-value";
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { Authorization: { secret: true, value: secretValue } });
      let receivedAuthorization: string | undefined;
      await withServer(
        (req: IncomingMessage, res) => {
          receivedAuthorization = req.headers["authorization"] as string | undefined;
          respond(res, 200, { "content-type": "text/plain" }, "ok");
        },
        async (baseUrl) => {
          await withStore(async (store) => {
            const recipe = recipeFor(`${baseUrl}/authed`, { headers: [{ name: "Authorization", secret: true }] });
            const { record } = await performFetch(recipe, { localDir }, store, { now: FETCH_NOW });

            expect(receivedAuthorization).toBe(secretValue);
            expect(record.recipe.declared).toEqual([{ name: "Authorization", secret: true }]);

            const binding = record.observation.bindings.find((entry) => entry.name === "Authorization")!;
            expect(binding.value).toBeNull();
            expect(typeof binding.keyedHash).toBe("string");
            expect(typeof binding.keyId).toBe("string");

            const text = new TextDecoder().decode(canonicalBytes(record));
            expect(text).toContain("Authorization");
            expect(text).toContain(binding.keyedHash!);
            expect(text).not.toContain(secretValue);
          });
        },
      );
    });
  });

  test("a body containing a bound secret comes back scrubbed with a report, and the secret is nowhere in the receipt", async () => {
    const secretValue = "supersecretechoedvalue";
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: secretValue } });
      await withServer(
        (_req, res) => respond(res, 200, { "content-type": "text/plain" }, `token=${secretValue} again=${secretValue}`),
        async (baseUrl) => {
          await withStore(async (store) => {
            const recipe = recipeFor(`${baseUrl}/echo`, { names: [{ name: "TOKEN", secret: true }] });
            const { record } = await performFetch(recipe, { localDir }, store, { now: FETCH_NOW });

            expect(record.observation.output).not.toContain(secretValue);
            expect(record.observation.scrubbed).toEqual([{ name: "TOKEN", count: 2 }]);
            expect(new TextDecoder().decode(canonicalBytes(record))).not.toContain(secretValue);
          });
        },
      );
    });
  });

  test("a transport failure produces a run record rather than a thrown error, distinguishable by its exit-code field", async () => {
    const port = await closedPort();
    await withStore(async (store) => {
      const { record } = await performFetch(recipeFor(`http://127.0.0.1:${port}/`), {}, store, { now: FETCH_NOW });
      expect(record.kind).toBe("run");
      expect(record.observation.exitCode).toBe(-1);
      expect(record.observation.exitCode).not.toBe(200);
    });
  });

  test("the receipt's recipe holds no local path: the test's own directory and the invoking home directory never appear in its canonical bytes", async () => {
    const body = "a body with nothing local in it";
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "plain-value" } });
      await withServer(
        (_req, res) => respond(res, 200, { "content-type": "text/plain" }, body),
        async (baseUrl) => {
          await withStore(async (store) => {
            const recipe = recipeFor(`${baseUrl}/plain`, { names: [{ name: "NAME", secret: false }] });
            const { record } = await performFetch(recipe, { localDir }, store, { now: FETCH_NOW });

            const text = new TextDecoder().decode(canonicalBytes(record));
            expect(text).not.toContain(tmpdir());
            expect(text).not.toContain(homedir());
            expect(record.recipe.workingDirectory).toBe("");
          });
        },
      );
    });
  });

  test("reuses the binding and scrub paths rather than reimplementing them", async () => {
    const { readFile: readSourceFile } = await import("node:fs/promises");
    const source = await readSourceFile(new URL("../src/fetch.ts", import.meta.url), "utf8");
    expect((source.match(/bindDeclaredNames/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((source.match(/scrubOutput/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

/** Assembled at run time, so no credential-shaped literal sits in this repository. */
const CREDENTIAL_SHAPED: readonly { readonly shape: string; readonly text: string }[] = [
  { shape: "a PEM private key", text: ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("") },
  { shape: "an AWS access key id", text: ["AK", "IA", "Q".repeat(16)].join("") },
  { shape: "a GitHub token", text: ["gh", "p_", "a1".repeat(18)].join("") },
  { shape: "a GitHub token", text: ["github", "_pat_", "B2".repeat(11)].join("") },
  { shape: "an sk- prefixed API key", text: ["s", "k-", "ant-api03-", "c3".repeat(12)].join("") },
  { shape: "a Slack token", text: ["xo", "xb-", "1234567890-abc"].join("") },
  { shape: "a Google API key", text: ["AI", "za", "d4".repeat(17), "e"].join("") },
  { shape: "a Stripe live key", text: ["sk", "_live_", "f5".repeat(12)].join("") },
];

describe("refuseCredentialIn: a fetched body shaped like a credential nobody declared", () => {
  test.each(CREDENTIAL_SHAPED)(
    "refuses $shape, naming the shape and where it starts but never the text",
    ({ shape, text }) => {
      const body = `a pasted log line\n${text} and the rest`;
      let refusal: unknown;
      try {
        refuseCredentialIn("https://example.test/gist", body);
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(RunRefusedError);
      expect((refusal as RunRefusedError).message).toContain(shape);
      expect((refusal as RunRefusedError).message).toContain(`character ${body.indexOf(text)}`);
      expect((refusal as RunRefusedError).message).not.toContain(text);
    },
  );

  test("lets through prose that only resembles a credential", () => {
    const prose = [
      "-----BEGIN PUBLIC KEY-----",
      "scikit-learn is imported as sk-learn in some notebooks",
      "the AKIA prefix marks an AWS access key id",
      "a Slack token starts xoxb-",
      "gh_pages and github_pat are branch and variable names here",
    ].join("\n");

    expect(() => refuseCredentialIn("https://example.test/notes", prose)).not.toThrow();
  });
});

describe("performFetch: a credential in a fetched body", () => {
  const leaked = ["gh", "p_", "Zz9".repeat(12)].join("");

  test("a body carrying a credential nobody declared is refused, and no receipt is minted", async () => {
    await withServer(
      (_req, res) => respond(res, 200, { "content-type": "text/plain" }, `build log\ntoken ${leaked}\n`),
      async (baseUrl) => {
        await withStore(async (store) => {
          const fetched = performFetch(recipeFor(`${baseUrl}/gist`), {}, store, { now: FETCH_NOW });

          await expect(fetched).rejects.toBeInstanceOf(RunRefusedError);
          await expect(fetched).rejects.toThrow("a GitHub token");
        });
      },
    );
  });

  test("the same credential bound as a secret is scrubbed from the body, and the citation lands", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { LEAKED: { secret: true, value: leaked } });
      await withServer(
        (_req, res) => respond(res, 200, { "content-type": "text/plain" }, `build log\ntoken ${leaked}\n`),
        async (baseUrl) => {
          await withStore(async (store) => {
            const recipe = recipeFor(`${baseUrl}/gist`, { names: [{ name: "LEAKED", secret: true }] });
            const { record } = await performFetch(recipe, { localDir }, store, { now: FETCH_NOW });

            expect(record.observation.scrubbed).toEqual([{ name: "LEAKED", count: 1 }]);
            expect(new TextDecoder().decode(canonicalBytes(record))).not.toContain(leaked);
          });
        },
      );
    });
  });
});
