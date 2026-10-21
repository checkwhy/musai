import { buildRegistry, type Distribution } from "@musai/api-core";
import { DEPRECATED_REASONS } from "@musai/records";
import { admitDrafts } from "./drafts.js";
import { ALL_OPERATIONS } from "./ops/index.js";

/** Every operation the distribution declares, keyed by `id@version`. */
export const REGISTRY = buildRegistry(ALL_OPERATIONS, DEPRECATED_REASONS);

/** The musai distribution as a surface is handed it. */
export const MUSAI: Distribution = {
  name: "musai",
  command: "musai",
  version: "0.1.1",
  registry: REGISTRY,
  admitDrafts,
  publicOperations: new Set([
    "workspace.init@1",
    "check.run@1",
    "claim.status@3",
    "claim.why@4",
    "render.markdown@2",
    "bundle.export@2",
    "bundle.rerun@3",
    "doctor.run@2",
  ]),
  startHere: 'Start here: musai init, then musai check "tests pass" -- node --test',
};
