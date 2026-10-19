# Operation log fixtures

An operation log is a fixture in the same `records/<kind>/<prefix>/<hex>.json`
layout the module fixture store already uses for a contribution's own
fixtures: one file per record, sharded on the first two hex characters of its
id, holding the record's own canonical bytes with a trailing newline. A
replay places these bytes in a fixture workspace as a merge places a record
arriving whole, keeping each record's version and id, so a record this
directory holds that the store would refuse to read fails the replay rather
than passing silently.

Beside `records/`, a `requests/` directory holds the recorded calls: one pair
of files per call, named `<operation-id>@<version>.request.json` and
`<operation-id>@<version>.response.json`. The request file names the
operation and carries its input exactly as a surface would assemble it; the
response file holds the recorded output's own canonical bytes — the same
bytes `--json` would print, or an MCP tool call's structured content would
carry.

A replay reads every record file into a fresh fixture workspace, then for
each request file calls the named operation through `runHandler` with
performing switched off wherever an operation's own mode supports it, and
reconciles the answer against the recorded response byte-for-byte through
the same canonicalisation both sides went through — the golden path
`@musai/devkit`'s `test.ts` already runs for a contribution's own fixtures,
applied here to the operation registry instead. A mismatch names the
operation and the bytes that differ, never a silent pass.

This directory's own fixture — one run, one claim citing it, one case citing
the claim, and `case.soundcheck@1`'s recorded call over them — is replayed by
`packages/distribution/test/plan-mode.test.ts`.

## Regenerating

Nothing here moves when a kind's version moves: a record placed by its bytes
is read through the kind's normaliser, as any older record is. A record shape
the normalisers no longer read is the one change that needs a re-mint, in the
order nothing points at yet — the `run`, then the `claim` rewired to it, then
the `case` rewired to the claim — each written back as its own canonical bytes
plus the trailing newline under the id they digest to.
