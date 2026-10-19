# Orphan allowlist

`scripts/check-orphans.mjs` reads this file. Every row names an export with no production caller, or
a whole file no production code reaches, together with the phase that will reach it. A row is
permission to leave a mechanism unwired for a while, never permission to leave it unargued: the
check fails on an orphan that is on no row, and on a row whose symbol or file is no longer an
orphan, so the list can neither grow in silence nor rot into permission nobody uses.

A phase number belongs here and nowhere else, because this is a planning artifact rather than code.

## Symbols

| Symbol | File | Phase or decision |
| --- | --- | --- |
| `coded` | `packages/records/src/conditions/scope.ts` | 5 — the roles file's own scope grammar, which the authority matrix already sorts in full. The file's other four unwired constructors, `from`, `set`, `range` and `until`, are invisible to a text scan because their names collide with unrelated locals, and the phase that wires these four finishes all seven |
| `except` | `packages/records/src/conditions/scope.ts` | 5 — the roles file's own scope grammar, which the authority matrix already sorts in full. The file's other four unwired constructors, `from`, `set`, `range` and `until`, are invisible to a text scan because their names collide with unrelated locals, and the phase that wires these four finishes all seven |
| `EMPTY_SCOPE` | `packages/records/src/conditions/scope.ts` | 5 — the empty end of the same algebra, beside `ANY_SCOPE`. The file's other four unwired constructors, `from`, `set`, `range` and `until`, are invisible to a text scan because their names collide with unrelated locals, and the phase that wires these four finishes all seven |
| `checkIndexProvider` | `packages/fold/src/sqlite-provider.ts` | decision — the conformance contract a provider is held to, run by the check script and the fold suite, which are not production callers by design |
| `removeViewWorktree` | `packages/store/src/worktree.ts` | 6 — a case opened in a fresh worktree is closed again there |

## Files

| File | Phase or decision |
| --- | --- |
