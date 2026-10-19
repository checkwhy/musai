# Records minted at previous schema versions

Nine records, one of each kind, written by a kernel that is now behind this
one. They are the past: **nothing here is ever regenerated.** A record whose
bytes stop reading under the current kernel is a normaliser that is missing or
wrong, and re-minting the fixture to make the suite green would erase the only
evidence of it this repository holds.

Each file sits at the path the store writes it to, holds exactly the bytes git
holds (canonical JSON, no trailing newline), and is named by the id those bytes
digest to — `shasum -a 256 <file>` reproduces the filename. A file here is read
exactly as the fold receives it from git.

## The five that are real

Copied byte for byte out of this repository's own workspace, `.lineup`, at
`scope/default` `18632247c840f07e0135462df87de9dc0ffc1785` — the project's first
real case and the first ruling made on it. They are not fixtures anyone wrote
for a test; they are records under the one-way rule. The workspace they came from
was removed when record paths gained a second shard level, which that workspace's
own history could not be read under, so this directory is where they are kept.

| Record | Declared version | What it is |
| --- | --- | --- |
| `claim/92/1e/921e892d…` | 2 | `triple@1`, the claim that a hygiene run's binary resolution is the thing under judgment |
| `case/82/24/8224a39f…` | 2 | the case `hygiene-binary-resolution`, booked under the bare preset |
| `run/94/6c/946cb831…` | 1 | the brief rendered to ask for a ruling on that claim |
| `ruling/4c/00/4c006fc5…` | 2 | the ruling that the claim holds, citing that brief |
| `attestation/42/eb/42eb14cc…` | 2 | `made`, by the person `florin` at a tty |

## The four that were minted for this tree

No record of these kinds exists anywhere — no writer mints an argument, a rule
or a testimony run yet, and no module or artifact has been written outside a
test — so a kernel at `3f6cd65` minted one of each through `Store.putMany`,
which is the only way bytes at a previous version can still be obtained once
the version moves. Each references the real ids above, so the nine fold into one
internally consistent scope.

| Record | Declared version | What it is |
| --- | --- | --- |
| `argument/90/ca/90ca7967…` | 1 | supports the real claim, no evidence |
| `artifact/81/06/81067130…` | 2 | a draft over the real case whose receipts section anchors the real brief run |
| `module/c6/e9/c6e93901…` | 1 | data-only (no bundle, no build), contributing one parser |
| `rule/05/2c/052cb330…` | 1 | scope `{ platform: "linux" }`, weight `1` |

## The signature

`attestation/42/eb/42eb14cc….json.sig` is a detached signature over that
attestation's **stored bytes**, made under the `lineup` namespace by a throwaway
ed25519 key whose public half is the one line in `allowed-signers` beside this
file. The private half was destroyed; nothing here needs to sign again.

The kernel has since signed and verified under the `musai` namespace, so this sidecar is kept as
the past and no longer verifies; `../signature/` holds the same stored bytes signed under `musai`,
and the suite and the conformance bundles carry that one.

It is the sharpest thing in the tree. A signature is a fact about the bytes
somebody signed, so verification must be handed those bytes and never a record
re-canonicalised after normalisation — the moment the attestation kind's version
moves, a verifier that re-canonicalises produces different bytes and this
signature stops verifying. That is what `previous-versions.test.ts` pins.
