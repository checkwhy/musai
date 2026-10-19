# Orphan allowlist

Bait for the orphan check: both rows below name what `caller.ts` reaches, an export and the file
declaring it, so each row grants permission nobody is using.

## Symbols

| Symbol | File | Phase or decision |
| --- | --- | --- |
| `reached` | `packages/records/src/reached.ts` | kept after the export gained a production caller |

## Files

| File | Phase or decision |
| --- | --- |
| `packages/records/src/reached.ts` | kept after the file gained a production caller |
