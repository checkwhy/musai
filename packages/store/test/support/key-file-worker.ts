import { fixedClock, SCENARIO_INSTANT } from "@musai/test-support";
import { mintKeyFile, rotateKey } from "../../src/keys.js";

// execa's exit hook re-raises SIGXFSZ, killing the worker before the write can fail with EFBIG.
process.on("SIGXFSZ", () => {});

async function main(): Promise<void> {
  const [verb, localDir] = process.argv.slice(2);
  if ((verb !== "mint" && verb !== "rotate") || !localDir) {
    throw new Error("usage: key-file-worker <mint|rotate> <localDir>");
  }
  const now = fixedClock(SCENARIO_INSTANT);
  await (verb === "mint" ? mintKeyFile(localDir, { now }) : rotateKey(localDir, { now }));
}

main().then(
  () => process.stdout.write(JSON.stringify({ ok: true })),
  (error: unknown) => process.stdout.write(JSON.stringify({ ok: false, error: String(error) })),
);
