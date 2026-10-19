# musai-verify

Check a musai bundle as its receiver: no Node, no git, no ssh-keygen, and
signatures checked against keys you chose rather than keys the sender chose.

```console
$ curl -sSfLO https://github.com/checkwhy/musai/releases/download/verify%2Fv0.1.0/musai-verify-linux-amd64
$ chmod +x musai-verify-linux-amd64 && mv musai-verify-linux-amd64 musai-verify

$ musai-verify verify path/to/bundle
info    sig.verified    records/attestation/42/eb/42eb14cc….json.sig: signed by florin (SHA256:y4ICVW80…), trusted by allowed-signers line 1
warning ref.pin-absent  records/case/82/24/8224a39f….json $.preset.moduleRecord: sha256:6a98c3a9… is not in the source; a distribution may hold it
verified: 9 records, 1 signature verified, 0 errors, 1 warning
released: not checked (no manifest)
signatures checked against the bundle's own allowed-signers: whoever sent it chose them; pass --trust for keys you chose

$ musai-verify verify --trust florin=github:florinutz path/to/bundle
…
verified: 9 records, 1 signature verified, 0 errors, 1 warning
signatures checked against florin's keys on GitHub (github.com/florinutz.keys, …)

$ musai-verify trace --source path/to/bundle 921e892d
claim sha256:921e892da524…  triple@1 · urn:musai:kernel:hygiene-binary-resolution concerns hygiene-binary-res…
├─ ← $.claim of ruling 4c006fc58e70…  holds · A binary is a name-and-digest descriptor, portable by name, with the di…
│  ├─ $.brief → run 946cb831732c…  brief · performer not recorded · determinism not recorded
│  │  └─ ← $.content of artifact 810671302cf1…  drafted · text/markdown
│  └─ ← $.subject of attestation 42eb14cc4376…  made by florin via tty · signature verified
├─ ← $.claims[*] of case 8224a39f5eda…  hygiene-binary-resolution
└─ ← $.target of argument 90ca79676a1b…  The finding this claim concerns was reported against binary resolution …

$ musai-verify recipe --source path/to/bundle 946cb831
run sha256:946cb831732c…  brief
isolation          none
working directory  .  (relative to a substrate, never this machine)
substrates
  scope-head               gitCommit 6ea7e9a29f850873086f2eaebd3bed913bf75a27
  case                     sha256 8224a39f5eda0207790d1350440b36895c54872d3bf1a6f84de89de72976e4f3
  …
command
  brief sha256:921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68
```

A bundle comes from the sender's `musai export`, which releases a record and
everything it needs beside it to an audience, signed, and writes them as a
`.tar.gz` with a `bundle.json` naming the record, the audience and when:

```console
$ musai export <ruling> --to public --out ruling.tar.gz
released 4226620cda8b for review, cite
ruling.tar.gz
bundle 66992b50e160ebd970ee1a52c7cbb056f80ae9abf1083f5bc40f56f9a788b697
6 records, 3 signatures, 0 blobs

$ musai-verify verify ruling.tar.gz
…
verified: 6 records, 3 signatures verified, 0 errors, 1 warning
released: public — 4 of 4 records covered
```

What a bundle may be used for is its own verdict line, and never turns the
integrity verdict red: `released:` says how many of its records a standing
release covers for the audience the bundle was cut for, read against its
`roles` and `audiences` files. `--as key:SHA256:…` (or `identity:…`) asks
whether you are in that audience.

The bundle above is `conformance/bundles/passing` in this repository. Or
`go install github.com/checkwhy/musai/verify/cmd/musai-verify@latest`.
Every release asset carries signed build provenance:
`gh attestation verify musai-verify --repo checkwhy/musai`.

## What it checks

A **source** is a bundle directory, a zip or a tar of one, gzipped or not
(entries under one top folder are fine, beside the `__MACOSX/` macOS adds;
a link, a path escaping the archive, a name given twice, two names differing
only by case or more than 512 MiB once expanded refuses the archive), a directory holding one bundle folder, or a musai workspace, read at `scope/default` unless `--scope`
names another. A bundle is the tree a scope branch holds, with the trust
branch's files at its root:

```
records/<kind>/<xx>/<yy>/<hex>.json           every record, as its canonical bytes; xx, yy its hex's first pairs
records/attestation/…/<hex>.json.sig           a signed attestation's detached signature
allowed-signers, config.json, roles            the trust branch's files
blobs/<first two hex>/<hex>                    payloads too large to inline, where held
```

1. **Ids.** Every record's bytes are their own RFC 8785 canonical form and
   digest to the id its path names, under the directory its kind names.
2. **References.** Every record id a record names at a path the reference
   table lists resolves to a record the source holds, of a kind the table
   allows there: ids in their own fields, an artifact's receipt anchors, and
   a run's read-set by its bare digests. A value spelled as an id at a path
   the table does not name is itself a finding, so a new field carrying one
   cannot slip past it. What the table leaves alone, it says: the strings a
   pack, a performer or a person wrote (a claim's canonical form, a run's
   recipe and output), object keys, and a recipe's substrate digests, which
   may name a record, a file or an image and are printed by `recipe` rather
   than resolved.
3. **Signatures.** Every sidecar verifies over the attestation's stored bytes
   under the namespace `musai`, from a key `allowed-signers` lists for the
   attestation's principal, whose `namespaces` and validity window admit it at
   the attestation's own time: the answer `ssh-keygen -Y verify` gives, held to
   it by a differential test. A time in `allowed-signers` with no zone is read
   as UTC on every machine, and warned about, since ssh-keygen would read it
   in its host's local time.

   **Whose keys.** By default the keys are the bundle's own, which proves the
   bundle agrees with itself, not who made it: whoever sent it chose them.
   `--trust` names keys you chose instead, and can be repeated:

   | `--trust` | Trusts |
   | --- | --- |
   | `florin=github:florinutz` | the SSH keys GitHub publishes for the account `florinutz`, for the principal `florin` and each key's own form, `key:SHA256:…` |
   | `florin=SHA256:y4ICVW80…` | one key, by the fingerprint `ssh-keygen -lf` prints, for the principal `florin` and the key's own form |
   | `path/to/dir` | the `allowed-signers` file in that directory |
   | `main` or a commit | a workspace's trust branch at that commit |

   The summary under every verdict names whose keys they were, and `--json`
   records each trust source in the report's recipe: a GitHub account by the
   digest of the keys it served, a pin as written, a directory by its digest.
4. **Blobs.** Where the source holds blobs, each one a record names digests to
   its id.

It never mints a record and never evaluates one: whether a claim holds is the
kernel's to say. `trace` shows what each record says of itself and who signed
what, a signer named by its key, `key:SHA256:…`, with the name the trusted
allowed-signers list beside that key.

Every finding has a stable code, and `conformance/bundles.json` names the
codes each tampered bundle must produce.

| Code | Severity | Meaning |
| --- | --- | --- |
| `source.empty` | error | the source holds no record |
| `source.unreadable` | error | a file the source holds whose bytes cannot be read, as in a zip damaged in transit |
| `record.unreadable` | error | not UTF-8 JSON with distinct keys, not a record kind, or an attestation of a version the kernel reads (2 to 6) that it would not hold, such as one at version 6 naming its principal by neither a key nor a pseudonym, the detail saying which rule it breaks; a later version is read unchecked |
| `record.not-canonical` | error | the stored bytes are not their own canonical form |
| `record.not-nfc` | error | a string or key at a path the reference table lists as a statement is not in Unicode NFC |
| `record.id-mismatch` | error | the bytes digest to another id than the path names |
| `record.path-mismatch` | error | stored under another kind's or prefix's directory |
| `record.stray` | warning | a file under `records/` that is neither a record nor a signature |
| `ref.dangling` | error | a citation names a record the source does not hold |
| `ref.pin-absent` | warning | a pin (a case's preset module) names a record a distribution may hold |
| `ref.kind-mismatch` | error | a reference names a record of a kind the table does not allow there |
| `ref.unlisted` | error | an id at a path the reference table does not name |
| `sig.verified` | info | a signature verified; the detail names the principal and key. A signature beside a record the verifier refused is neither verified nor counted |
| `sig.absent` | info | an attestation with no signature |
| `sig.orphan` | error | a signature beside no record |
| `sig.malformed` | error | not an armored SSH signature, or no principal and time to check it at |
| `sig.namespace` | error | signed under a namespace other than `musai` |
| `sig.bad` | error | the signature does not verify over the stored bytes |
| `sig.principal-unknown` | error | no allowed-signers line names the principal with that key |
| `sig.namespace-not-permitted` | error | the line's `namespaces` excludes `musai` |
| `sig.not-yet-valid`, `sig.expired` | error | the attestation's time is outside the line's window |
| `sig.certificate-unsupported` | error | the signature was made by a certificate |
| `trust.line-invalid` | warning | an allowed-signers line ssh-keygen would skip |
| `trust.zoneless-time` | warning | an allowed-signers time with no zone, read as UTC here and as local time by ssh-keygen |
| `trust.key-mismatch` | error | an allowed-signers line listing a key form, `key:SHA256:…`, that is not its own key's fingerprint: one key never speaks as another, so the line is not trusted |
| `blob.mismatch` | error | a held blob digests to another id |
| `blob.absent` | warning | the source holds blobs, but not this one |
| `release.covered` | info | a standing release covers the bundle's audience; the detail names its principal, extent, uses, marking and window |
| `release.uncovered` | warning | a record no standing release in the bundle covers for its audience |
| `release.unauthorised` | warning | a release by a principal the bundle's `roles` grants no `publish` |
| `release.relayed` | warning | a release relayed through a model, which stands for no audience |
| `release.audience-unknown` | warning | a release to a form of audience this verifier does not know, which only a later schema version can carry; it covers nothing |
| `release.window` | warning | a release whose window excludes the time the bundle was cut, checked against the sender's time |
| `release.unchecked` | info | no `bundle.json` names an audience, so entitlement is not checked |
| `release.member`, `release.not-member` | info, warning | whether the receiver `--as` names is in the bundle's audience |

## Exit codes and the report

| Exit | Meaning |
| --- | --- |
| 0 | verified: no finding is an error |
| 1 | the verifier itself failed |
| 2 | fix the invocation: not a source, an unknown id, a bad flag |
| 3 | verification failed; the findings say what |

`verify --json` writes the report as a **run draft** in the kernel's own field
names, in canonical JSON: a run performed by a `foreign` performer (the
`--principal` standing behind it, the tool `musai-verify` and its version),
whose recipe names the bundle by digest and the verifier by version, and whose
observation carries the findings as canonical JSON and the verdict as its exit
code. The kernel admits it as a citation without translation; the verifier does
not give it an id.

The bundle's digest is what `sha256sum` says over its files, reproducible with
coreutils:

```console
$ (cd bundle && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 sha256sum) | sha256sum
```

A directory, a zip and a tar holding the same files digest alike, and
`musai export` prints the same digest for the bundle it writes. A workspace
digests over its whole scope, so it digests alike with a bundle only when the
bundle holds the same files; an export holds one record's closure.

## WebAssembly

`./wasm` builds for `js/wasm` and `wasip1/wasm`, each under 3 MB gzipped: an
archived bundle in, the report out. Under js it registers
`musaiVerify(archive: Uint8Array | ArrayBuffer, principal: string, options?)`,
where `options` may carry `trust`, a list of `--trust` specs of the forms that
need no network or filesystem (`<principal>=SHA256:<fingerprint>`), and
`allowedSigners`, the text of an allowed-signers file; either replaces the
bundle's own. It answers `{ exitCode, report, summary }`, the summary being
`{ records, signatures, trust }` as the command line prints them, or
`{ exitCode, error }`. Under wasip1 it reads the archive on stdin, takes the
principal as its argument, trusts the bundle's own keys and exits with the
verdict. The WebAssembly builds read archives, not a workspace's git
repository.

## In the browser

`web/` is a page around the js build: drop a `.tar.gz` or a `.zip`, and it
shows the verdict, the summary, the bundle's digest and every finding, checked
against the bundle's own allowed-signers or against keys pasted or pinned on
the page, and offers the report to download. Nothing is sent anywhere. A tag
publishes it to GitHub Pages and attaches it to the release as
`musai-verify-page.zip`; to serve it yourself:

```console
$ go run ./tools/webbuild -out site
$ python3 -m http.server -d site
```

## Held to the kernel

`../conformance/` is written by the TypeScript kernel and read here:
the canonical vectors, a few thousand random values in non-canonical spellings
with the kernel's canonical bytes for each, the reference table (embedded in
the binary as `internal/refs/references.json`, byte for byte), the tampered
bundles with each one's digest, and an archive the kernel's own `musai
export` wrote. `musai-verify conformance ../conformance` runs all of it and CI runs
it on every push.

## Developing

Go 1.27.1 (`toolchain` in `go.mod` fetches it), golangci-lint 2.14.0 as a
binary with gofumpt and a depguard rule confining go-git to
`internal/source/gitrepo`.

```console
$ go test ./...
$ golangci-lint run ./...
$ GOOS=js GOARCH=wasm golangci-lint run ./wasm/... ./internal/...
$ go test -run '^$' -fuzz FuzzCanonicalIsIdempotentAndNeverPanics -fuzztime 30s ./internal/canon
$ node --test web/test/page.test.mjs     # headless Chromium, CHROME_BIN or Playwright's
```

A tag `verify/vX.Y.Z` releases it and publishes the page.
