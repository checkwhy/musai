export { type BlobStore, GitBlobStore } from "./blob-store.js";
export {
  editedConfig,
  type MainFileContent,
  projectLayerSlots,
  readTrustBranch,
  readWorkspaceConfig,
  SLOTS_CONFIG_KEY,
  type TrustBranch,
  type WorkspaceConfig,
  writeMainFiles,
} from "./config.js";
export {
  type EnclosingIgnoreStatus,
  type GitContext,
  gitBranchDelete,
  gitBuildTree,
  gitCatFile,
  gitCheckIgnored,
  gitCommitTree,
  gitDiffTreePaths,
  gitHashObjectBatch,
  gitInitWorkTree,
  gitLooseObjectCount,
  gitLsTree,
  gitMkTree,
  gitOldestRootCommit,
  gitRevParse,
  gitWorkingTreeTree,
  gitWorktreeAdd,
  gitWorktreeForceCheckout,
  gitWorktreeList,
  gitWorktreeRemove,
  isAbsentPathError,
  type LsTreeEntry,
  resolveGitDir,
  resolveWorkTree,
  type TreeEntry,
  type WorktreeEntry,
} from "./git.js";
export {
  adoptWorkspace,
  initWorkspace,
  LOCAL_DIR,
  MUSAI_DIR,
  scopeClearedIndexPath,
  scopeIndexPath,
  scopeVerificationCachePath,
  type WorkspaceAdoption,
  type WorkspaceInit,
} from "./init.js";
export {
  currentKey,
  type KeyFile,
  KeyFileError,
  keyById,
  keyMaterial,
  listKeys,
  mintKeyFile,
  readKeyFile,
  rotateKey,
  type WorkspaceKey,
  workspaceKey,
} from "./keys.js";
export { packageRootFrom } from "./paths.js";
export type {
  ChangedPath,
  CommitChanges,
  HeldWrites,
  PlacedItem,
  PutItem,
  RecordStore,
  RecordWriter,
} from "./record-store.js";
export { ONE_LEVEL_REF_PREFIX, oneLevelRecordCount, type Relayout, relayoutScope } from "./relayout.js";
export {
  type CasAttemptResult,
  CasExhaustedError,
  type CasRetryHooks,
  type CasRetryOptions,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  withCasRetry,
} from "./retry.js";
export { type ScopeFile, scopeDifference } from "./scope-difference.js";
export { assertScopeAt, assertScopeFree, createScope, dropScope, listScopes, type ScopeTip } from "./scopes.js";
export {
  InvalidScopeError,
  type MergeOptions,
  type MergeResult,
  PACK_THRESHOLD,
  RecordNotFoundError,
  Store,
  type StoreOptions,
  scopeRefName,
} from "./store.js";
export {
  assertSafeSlugSegment,
  listViewWorktrees,
  materialiseView,
  mintViewCommit,
  OPEN_DIR,
  removeViewWorktree,
  VIEW_BRANCH_PREFIX,
  type ViewTreeFile,
  type ViewWorktree,
  WorktreeBoundaryError,
} from "./worktree.js";
