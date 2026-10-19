// The page, driven in a headless Chromium over the DevTools protocol with
// no dependency beyond Node: build it with webbuild, serve it, drop bundles
// on its file input, and read what it shows. Chromium is CHROME_BIN, or the
// one Playwright installs; without either the suite skips, saying so.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("../..", import.meta.url));
const conformance = join(moduleRoot, "..", "conformance");
const chrome =
  process.env.CHROME_BIN ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

/** Serves a directory's files, as a static host would. */
function serve(dir) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://page").pathname.replace(/^\/$/, "/index.html");
    const path = join(dir, name);
    if (!path.startsWith(dir) || !existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    response.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A Chromium showing `url`, and a DevTools session on its page. */
async function launch(url, profile) {
  const browser = spawn(
    chrome,
    ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", url],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let said = "";
    browser.stderr.on("data", (chunk) => {
      said += chunk;
      const listening = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (listening) {
        resolve(listening[1]);
      }
    });
    browser.on("exit", (code) => reject(new Error(`chromium exited ${code}: ${said}`)));
  });
  const { port } = new URL(endpoint);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const pending = new Map();
  let last = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      if (message.error) {
        waiting.reject(new Error(message.error.message));
      } else {
        waiting.resolve(message.result);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      last += 1;
      pending.set(last, { resolve, reject });
      socket.send(JSON.stringify({ id: last, method, params }));
    });
  const close = () => {
    socket.close();
    browser.kill();
  };
  return { send, close };
}

describe("the page", { skip: chrome === undefined && "no Chromium: set CHROME_BIN" }, () => {
  let scratch;
  let server;
  let page;

  const evaluate = async (expression) => {
    const answered = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answered.exceptionDetails) {
      throw new Error(answered.exceptionDetails.exception?.description ?? answered.exceptionDetails.text);
    }
    return answered.result.value;
  };

  const until = async (expression, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await evaluate(expression);
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(`never true: ${expression}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** Drops an archive on the page's file input and waits for its verdict. */
  const drop = async (archive) => {
    await evaluate(`document.querySelector("#verdict").dataset.state = "dropping"`);
    const { root } = await page.send("DOM.getDocument");
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#archive" });
    await page.send("DOM.setFileInputFiles", { nodeId, files: [archive] });
    return until(`(() => { const s = document.querySelector("#verdict").dataset.state; return s !== "dropping" && s !== "working" && s; })()`);
  };

  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);

  /** A bundle directory of the conformance corpus, as a tar.gz. */
  const tarred = (name) => {
    const archive = join(scratch, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", join(conformance, "bundles", name), "."]);
    return archive;
  };

  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), "musai-verify-page-"));
    const site = join(scratch, "site");
    execFileSync("go", ["run", "./tools/webbuild", "-out", site, "-version", "v0.0.0-test"], {
      cwd: moduleRoot,
      stdio: "inherit",
    });
    server = await serve(site);
    page = await launch(`http://127.0.0.1:${server.address().port}/`, join(scratch, "profile"));
    await page.send("Runtime.enable");
    await until(`document.readyState === "complete" && document.querySelector("#verdict")?.dataset.state === "idle"`);
  });

  after(() => {
    page?.close();
    server?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("shows a bundle that verifies green, saying what the command line says of it", async () => {
    assert.equal(await drop(tarred("passing")), "verified");
    assert.equal(await text("#summary"), "verified: 9 records, 1 signature verified, 0 errors, 1 warning");
    assert.equal(
      await text("#trust"),
      "signatures checked against the allowed-signers the bundle carries, which whoever sent it chose",
    );
    assert.match(await text("#caution"), /does not show who sent it/);
    assert.equal(await evaluate(`document.querySelector("#caution").hidden`), false);
    assert.match(await text("#digest"), /^[0-9a-f]{64}$/);
    assert.match(await text("#findings"), /ref\.pin-absent/);
  });

  test("shows a tampered bundle red, naming what failed", async () => {
    assert.equal(await drop(tarred("flipped-byte")), "failed");
    assert.match(await text("#summary"), /^FAILED: /);
    assert.match(await text("#findings"), /record\.id-mismatch/);
  });

  test("verifies the kernel's own export", async () => {
    assert.equal(await drop(join(conformance, "exports", "released.tar.gz")), "verified");
    assert.equal(await text("#summary"), "verified: 6 records, 3 signatures verified, 0 errors, 1 warning");
  });

  test("checks signatures against keys pasted in place of the bundle's own, and a pinned fingerprint", async () => {
    const absent = tarred("principal-absent");
    assert.equal(await drop(absent), "failed");

    const allowed = readFileSync(join(conformance, "bundles", "passing", "allowed-signers"), "utf8");
    await evaluate(`document.querySelector("#allowed-signers").value = ${JSON.stringify(allowed)}`);
    assert.equal(await drop(absent), "verified");
    assert.equal(await text("#trust"), "signatures checked against the allowed-signers you gave");
    assert.equal(await evaluate(`document.querySelector("#caution").hidden`), true);

    await evaluate(`document.querySelector("#allowed-signers").value = ""`);
    await evaluate(
      `document.querySelector("#pins").value = "florin=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY\\n"`,
    );
    assert.equal(await drop(absent), "verified");
    await evaluate(`document.querySelector("#pins").value = ""`);
  });

  test("says what to fix when the file is not a bundle, rather than a verdict", async () => {
    const junk = join(scratch, "junk.tar.gz");
    execFileSync("tar", ["-czf", junk, "-C", moduleRoot, "go.mod"]);
    assert.equal(await drop(junk), "refused");
    assert.match(await text("#summary"), /^Could not check it: .*not a bundle/);
  });

  test("says the keys are what to fix when they are keys it cannot use", async () => {
    await evaluate(`document.querySelector("#pins").value = "florin=github:florinutz"`);
    assert.equal(await drop(tarred("passing")), "refused");
    assert.match(await text("#summary"), /^Could not check it: .*fetches nothing; paste the keys/);
    await evaluate(`document.querySelector("#pins").value = ""`);
  });

  test("links the finding codes to the README of the version it serves", async () => {
    assert.equal(
      await evaluate(`document.querySelector("footer a").href`),
      "https://github.com/checkwhy/musai/blob/verify/v0.0.0-test/verify/README.md#what-it-checks",
    );
  });

  test("offers the report as the run draft the kernel admits, to download", async () => {
    await drop(tarred("passing"));
    const draft = await evaluate(`fetch(document.querySelector("#download").href).then((r) => r.json())`);
    assert.equal(draft.kind, "run");
    assert.equal(draft.performer.tool, "musai-verify");
    assert.equal(draft.observation.exitCode, 0);
  });

  test("shows what a bundle says as text, never as markup", async () => {
    await evaluate(`window.musaiVerify = () => ({
      exitCode: 3,
      report: JSON.stringify({
        performer: { version: "<i>devel</i>" },
        recipe: { substrates: [{ name: "bundle", digest: { sha256: "0".repeat(64) } }] },
        observation: { exitCode: 3, output: JSON.stringify([
          { code: "record.stray", severity: "warning", path: "<img src=x onerror=window.pwned=1>", detail: "<b>bold</b>" },
        ]) },
      }),
      summary: { records: 1, signatures: 0, trust: "<i>keys</i>" },
    })`);
    await drop(tarred("passing"));
    assert.equal(await evaluate(`document.querySelectorAll("#result img, #result b, #result i").length`), 0);
    assert.equal(await evaluate(`window.pwned`), undefined);
    assert.match(await text("#findings"), /<img src=x onerror=window\.pwned=1>/);
  });
});
