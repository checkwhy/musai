# A run's own identity moves with the host that resolved its binary

Two real runs of one recipe, changing nothing but which directory the invoking process's own
`PATH` resolves a declared binary from, mint two different run record ids for byte-identical
output. The recipe is unchanged and what it printed is unchanged; only the resolved binary's own
digest, recorded on the observation, differs — and the observation is part of what a run record's
id is minted over, so the two runs disagree on identity though they agree on everything a person
would call the result.

Two positions on this were recorded before it was resolved. One reads it as a leak: a run is
meant to see a declared environment, never the shell's, and the invoking process's own `PATH` is
exactly the shell's own value reaching in. The other reads the identical fact the opposite way: a
binary is a descriptor with a name and a digest and no locator, portable by name, with the digest
there for a receiver's own observation to differ on — divergence between two honest runs is the
point, not a leak.

**Reproduces:** `packages/distribution/test/first-case.test.ts` — one recipe, run twice from two
different shim directories holding byte-identical shim scripts, mints two different run record
ids for one byte-identical output.

**Resolution:** the second reading holds — a binary is a name-and-digest descriptor, and
divergence between two honest runs is by design. What actually needed fixing was a different
gap the same finding uncovered: nothing stopped a hygiene run from reaching for any binary on the
host's own search path, whether or not anything installed had asked for it as tooling. A hygiene
run now names only a binary some installed module has declared as a requirement, refused by name
before anything spawns otherwise; the goldens that once compared a run record id now compare a
recipe id and a selected item id, neither of which a resolved binary's digest ever touches.

**Fixed by:** a0aba0b — authorise a hygiene run's binary against a declared requirement

**Ruled by:** `sha256:4c006fc58e70d4e7df0d10469cd874f7897a6920edeaf35140949b954c5f539f` — the ruling this
project's own workspace carries settling which of the two recorded positions holds, on the case
booked as `hygiene-binary-resolution`. `musai why <claim>` against
`sha256:a36ae0e2c47ca4d55d26b48ebece9ad17991daac11252be004973cbf6b0c198d` walks from the claim
down through this ruling to the brief it cites.
