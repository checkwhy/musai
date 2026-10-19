export {
  type ClaimTypeDeclarations,
  ClaimTypeRefusedError,
  claimTypeDeclarationFromEntry,
  readClaimTypeDeclarations,
} from "./module/claim-type-registry.js";
export {
  type DimensionDeclarations,
  DimensionRefusedError,
  dimensionFromEntry,
  readDimensionDeclarations,
} from "./module/dimension-registry.js";
export {
  FoldRefusedError,
  foldExtensionsFrom,
  foldTableFromEntry,
  foldTablesFrom,
  readFoldDeclarations,
} from "./module/fold-registry.js";
export {
  firstAvailableHost,
  HOSTS,
  type HostContribution,
  type HostDescriptor,
  invokerFromModuleHost,
  invokeThroughHost,
  type ModuleHost,
} from "./module/hosts.js";
export {
  EMPTY_INSTALLED_MODULES,
  type InstalledModuleEntry,
  type InstalledModules,
  type InstallModuleResult,
  installModule,
} from "./module/install.js";
export { PointRefusedError, type PointRegistry, pointFor, readPointDeclarations } from "./module/point-registry.js";
export {
  QueryRefusedError,
  queryDeclarationFromEntry,
  queryFor,
  readQueryDeclarations,
} from "./module/query-registry.js";
export { partitionRequirementRows, readRequirementDeclarations } from "./module/requirements.js";
export { readPresetDeclarations, readSlotDeclarations } from "./module/slot-registry.js";
export {
  type SubprocessHandle,
  SubprocessHost,
  SubprocessHostError,
  type SubprocessHostOptions,
} from "./module/subprocess-host.js";
export type {
  Rule,
  RuleErrorOutput,
  RuleEvidence,
  RuleInput,
  RuleInvocation,
  RuleOutput,
  RuleRecord,
  RuleRefusal,
  RuleRequestOutput,
  RuleVerdictOutput,
} from "./rule/contract.js";
export {
  type AttestIntent,
  type ContributionPoint,
  DESCRIBE_OUTPUT_SCHEMA,
  type Diagnostic,
  decodeResponse,
  ENVELOPE_PROTOCOL,
  type EnvelopeError,
  type EnvelopeRequest,
  type EnvelopeResponse,
  type EnvelopeValidation,
  ERROR_CODES,
  type ErrorCode,
  type EventPayload,
  encodeRequest,
  type InvokedContribution,
  isErrorCode,
  isPointRole,
  kernelPoint,
  type Need,
  needId,
  type OperationPlan,
  type PlannedRecord,
  type PointRole,
  validateEnvelopeInput,
  validateEnvelopeOutput,
} from "./rule/envelope.js";
export {
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_TIME_LIMIT_MS,
  type HostInvocation,
  INVOCATION_LIMITS_SLOT_ID,
  type InProcessHandle,
  InProcessHost,
  type InvocationLimits,
  type InvokeRuleResult,
  type Invoker,
  invocationLimitsFromSlots,
  RuleImportError,
  readLogForRequest,
} from "./rule/host.js";
export { type ReadLog, recordRead } from "./rule/read-log.js";
