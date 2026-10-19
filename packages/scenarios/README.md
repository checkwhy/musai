# Scenarios

A scenario directory holds `scenario.json` (steps, replay, holds and unrecorded lists), a
`<name>.test.ts` calling `runScenario`, its fixture packs, and recorded answers under
`expected/`, one `.stdout` per step.

Every step runs `packages/distribution/dist/bin/cli.js`, never the source directly, so the root `pnpm test`
builds every package before it runs any suite; a filtered run of this package alone
(`pnpm --filter @musai/scenarios test`) needs `pnpm -r build` run first or it exercises whatever
build was already sitting in `dist`.

A step's `args` may use `$WORKSPACE`, `$REPO`, `$SCENARIO` for the three directories, and
`${step.path}` for a dotted field of an earlier step's parsed JSON output —
`${book.minted.1.record.slot}` reads the slot `book` minted second.

A scenario's workspace is a directory under the OS temp dir named for the clone's absolute path
and the scenario, so two clones running the suite at once share nothing; `normalise` spells it
`<workspace>` in every recorded byte.

`$KEYS` is a copy of the scenario's own `keys/`, made owner-only beside the workspace, since git
keeps no file mode and `ssh-keygen` refuses a key others may read. An Ed25519 signature is
deterministic, so a scenario that signs with a committed key, as `releasing` does, records the
same bytes on every run. That key's private half is published here, so `doctor` refuses any
workspace whose `allowed-signers` trusts it.

A `commit` step, `{ "id", "commit": { "repo", "from", "message" } }`, replaces everything in
`repo` but `.git` with a copy of `from` and commits it, creating the repository on first use. The
author, the committer, both dates and the empty system and global git configuration are pinned, so
the same trees committed in the same order answer the same commit on every run on one machine; its
output is `{ "commit", "tree" }`, read by later steps as `${step.commit}`. An `edit` step either
appends a string (`append`) or writes a whole JSON object whose string leaves have their
placeholders resolved (`json`), so a path it names stays valid JSON whatever separator it carries.

A step may carry its own `now`, a literal instant pinned through `MUSAI_NOW` in place of
`SCENARIO_INSTANT`, so a scenario can write an older record and a newer one — every step of every
scenario otherwise runs at the one instant the suite pins, so a listing's order can only ever be
proved on its tie-break. A step's `now` must not run time backwards relative to a step before it,
and it governs CLI steps only: a `commit` step keeps `SCENARIO_INSTANT` as both git dates, and an
`edit` step reads no clock.

A CLI step may carry its own `clearance`, set as `MUSAI_CLEARANCE` for that step alone, so one
workspace is read by its author and by a station cleared to an audience; a step naming none runs
uncleared, whatever the invoking shell sets.

`runScenario` checks three things: every step agrees between two runs from `init`; a `replay`
step answers as before once its fold, and every cleared fold beside it, is rebuilt; a `holds` step
reaches an `evidence` hop. Read a recorded diff before committing it: it may only be a
normalisation gap.

A companion test that must act on a scenario's workspace after its steps ran — which
`runScenario` cannot give, since it deletes its own — runs the scenario with `runScenarioInto`
instead, into a directory the test owns.

Unset, `MUSAI_SCENARIO_RECORD` compares the first run against `expected/`; `1` replaces
`expected/` with that run instead. A recording holds ids as placeholders and nothing else is
rewritten: each record id becomes `<id-N>`, numbered by its first appearance across the
scenario's recorded steps in step order, and a hex label of eight digits or more that begins
exactly one of those ids, such as a twelve-digit file name, becomes `<id-N:L>`, so one id is one
placeholder in every step and two ids stay two. The run's own output goes through the same
rewrite before the comparison, so a recording holding a real id fails it.

Ids are left out of a recording because they are a machine's: a receipt's observation names each
binary its run resolved by the binary's own digest (`packages/run/src/spawn.ts`, `performRecipe`):
every spawned run runs `node`, and a build adds its bundler (`packages/devkit/src/build.ts`,
`buildModule`), so a receipt id, and every record citing one, is this machine's by construction. A
build names its bundler by package and version, never where it sits, so a built module's record id
does not depend on the clone. The user does not enter: a gate's answer carries its principal
(`packages/cli/src/program.ts`, `terminalChannel`), and every step pins it through
`MUSAI_PRINCIPAL`. A recipe names none of this — its tree by digest, its paths relative to that
tree — and what proves it travels is two tests that run on any machine, in
`packages/devkit/test/devkit-build.test.ts` and `packages/run/test/runner-spawn.test.ts`. How an id
is derived is pinned apart from the recordings, in `packages/store/test/record-id.test.ts`.

A step whose bytes change with every commit to this repository goes in `unrecorded`, measured
rather than guessed: record with the list empty, commit anything, run again, and list exactly
the steps that differ. Such a step still runs and joins the cross-run and replay checks, but
skips `expected/` both ways.

The binary runs under a declared `PATH` — the node running the suite, this repository's own
bin directory, then the system directories — rather than the invoking shell's, because a build
records the digest of whichever `node` a `PATH` lookup resolves. On Windows, which has no fixed
system directories to name, the invoking shell's own entries are appended after the first two.
Elsewhere the declared `PATH` never carries them, so no scenario's `module build` finds a `bun` on
it and `subprocess-bun` reads as unavailable in recorded bytes; bun coverage rests on `modules`'
own host-equivalence tests, which run in-process under the ambient `PATH` and never go through this
suite.

`normalise` replaces what cannot be pinned: its own paths, commit shas, and any instant
`MUSAI_NOW` did not fix, whether git spells it with `Z` or with an offset. The user's name is left
alone: every step pins its principal, so the name reaches no output, and nothing in the text could
tell a user named the same as a record kind or a claim label from an actual principal. A CI
runner's user is named `runner`, the kind a run's performer carries.
