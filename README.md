# musai

A claim that knows when it stops holding. `check` turns a sentence and a command into a claim and
a receipt. The claim goes stale the moment the tree it read moves, `why` walks from the sentence
down to the receipt, and a bundle of it is something a stranger re-runs and verifies.

In a git repository with at least one commit:

```console
$ npm install --global checkwhy    # installs musai; or run npx checkwhy in its place
$ musai init
$ musai check "tests pass" -- node --test
✓ holds · ff02084dbb2f
$ echo "broken" >> src/answer.js
$ musai render
- [ ] ◌ tests pass (stale) — `musai why ff02084dbb2f`
$ musai status "tests pass"      # runs it again; exits 7, since it no longer holds
$ musai why "tests pass"         # re-runs a stale claim, then names the run that decided it
$ musai why "tests pass" --full  # the whole derivation, from the sentence down
```

`init` makes `.musai/`, a git repository of its own holding every claim and receipt; commit it
beside the code to keep them, and leave its `local/` directory ignored, as `init` does.

A claim is named by its sentence or by the short id `check` printed, and one sentence is one
claim: checking it again by another command is refused unless `--replace` says so. `why --plan`
answers from what already ran on the tree as it is now, running nothing. `status` exits 0 when the
claim holds and 7 when it fails, is stale or is open, and `check` exits by the run it just made, so
a CI step or a hook can gate on either; `musai doctor` prints every exit code.

## Words

- **claim**: a sentence and what judges it, a command or a rule. It **holds**, **fails**, is
  **stale** (the tree it read has moved since) or **open** (nothing has decided it yet).
- **receipt**: the record of one run: the command, the programs it ran by digest, the tree it read,
  its exit code and its last lines.
- **audience**: who an export is released to, such as `public` or a key, and a **release** is the
  signed grant that lets it leave.

## Install

The npm package is `checkwhy` and the command it installs is `musai`.
`npm install --global checkwhy` needs Node 24 or later and git; an older Node is named and refused
with exit code 6. The package carries everything it runs, and installs no dependency.

Before the first release reaches npm, build it from a clone, with pnpm:

```console
$ pnpm install && pnpm build
$ alias musai="node $PWD/packages/distribution/dist/bin/cli.js"
```

## What a check runs with

A check runs in a declared environment, never the shell's: its `PATH` holds the programs it names
and nothing beside them, so its receipt records every program by digest. Name each program the
command reaches for with `--tool`. What a package manager's launcher reaches for depends on how it
was installed: `pnpm test` here needs `--tool sh --tool node`, and on a machine whose pnpm launcher
is a shell script, `--tool sed` too. When a check fails as if a program were missing, it says
which. A `check` whose programs all resolve adds those it named to the workspace's toolset,
`tools` in `config.json` on the workspace's trust branch, and every check after lists the whole
toolset; a check that fails for a missing program adds none of them.

A command that writes into the tree it checks, such as a lockfile or a cache git does not ignore,
leaves the claim stale as soon as it ran; `check` names the paths it moved.

## Handing it to someone else

An export is signed, so name your SSH key once: `musai init --key ~/.ssh/id_ed25519`. Then
`musai export "tests pass" --to public --out ../tests.tar.gz` releases a claim, everything it
cites and the receipts it rests on to an audience, signed, and writes them as a bundle, outside the
tree, since a file there that git does not ignore moves the tree every check read. The receiver runs
`musai rerun tests.tar.gz` in their clone of the same repository: it checks the bundle, names the
key that signed its release, shows each command and whether the tree here is the one its receipt
read, and with `--yes` runs them. A run matches its receipt when its exit code does,
since that is all a check expects; output that moved, such as a timing, is named beside it.
`musai-verify`, one Go binary, checks a bundle without Node, git or ssh-keygen: take it for your
platform from this repository's releases, or run
`go install github.com/checkwhy/musai/verify/cmd/musai-verify@latest`; `verify/README.md` says
what it checks.
`musai lab release` sets other terms, and `musai lab revoke` withdraws a release, which a
later export never undoes.

## In CI

A repository that commits `.musai/` gets one Check Run per push from the action in this
repository, in a job holding `checks: write`:

```yaml
- uses: checkwhy/musai/action@v0.1.0
```

It re-checks each claim on the pushed commit, lists each with its `why`, and fails when one does
not hold.

## Further

- `DESIGN.md`: what the records, the receipts and the rules are.
- `musai lab`: every other verb, from booking cases to rulings.
- `plugin/README.md`: the Claude Code plugin.

## Licence

Apache-2.0: see `LICENSE`.
