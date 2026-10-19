import type { OperationDescriptor } from "@musai/api-core";
import { blobImport } from "./blobs.js";
import { briefRender } from "./brief.js";
import { caseBook, caseSoundcheck } from "./case.js";
import { caseStatus } from "./case-status.js";
import { challengeFile } from "./challenge.js";
import { checkRun } from "./check.js";
import { claimStatus } from "./claim.js";
import { configGet, configSet, configUnset } from "./config.js";
import { doctorRun } from "./doctor.js";
import { eventsSinceOperation } from "./events.js";
import { bundleExport } from "./export.js";
import { gateAnswer, gateAsk, gatePending } from "./gate.js";
import { hookStop } from "./hook.js";
import { keyList, keyRotate } from "./key.js";
import { moduleBuild, moduleNew, moduleTest } from "./module.js";
import { caseOpen } from "./open.js";
import { pluginSync } from "./plugin.js";
import { releaseGrant, releaseRevoke, releaseSeal } from "./release.js";
import { renderMarkdown } from "./render.js";
import { bundleRerun } from "./rerun.js";
import { rulingMake } from "./ruling.js";
import { caseSave } from "./save.js";
import { scopeDrop, scopeFork, scopeList, scopeMerge } from "./scope.js";
import { storeRelayout } from "./store.js";
import { viewRun } from "./view.js";
import { claimWhy } from "./why.js";
import { workspaceInit } from "./workspace.js";

export const ALL_OPERATIONS: readonly OperationDescriptor[] = [
  blobImport,
  briefRender,
  bundleExport,
  bundleRerun,
  caseBook,
  caseOpen,
  caseSave,
  caseSoundcheck,
  caseStatus,
  challengeFile,
  checkRun,
  claimStatus,
  claimWhy,
  configGet,
  configSet,
  configUnset,
  doctorRun,
  eventsSinceOperation,
  gateAnswer,
  gateAsk,
  gatePending,
  hookStop,
  keyList,
  keyRotate,
  moduleBuild,
  moduleNew,
  moduleTest,
  pluginSync,
  releaseGrant,
  releaseRevoke,
  releaseSeal,
  renderMarkdown,
  rulingMake,
  scopeDrop,
  scopeFork,
  scopeList,
  scopeMerge,
  storeRelayout,
  viewRun,
  workspaceInit,
];
