# Conformance

What a second implementation of musai's record form runs to stay the kernel's
twin. The kernel's own suites hold every file here to what its generators write;
the Go verifier in `verify/` reads them in its tests. Nothing here is edited by
hand. The signed bundles and the exports are signed by a key made for the run
and deleted after it, so their signatures, and the digests of the bundles
holding them, change each time their generator runs. An export's records
change too wherever they rest on the core module its workspace built, whose
build receipt is the generating machine's.

| File | What it pins | Written by |
| --- | --- | --- |
| `canonical.json` | the kernel's canonical vectors: each input, its RFC 8785 text and its id | `pnpm --filter @musai/records conformance` |
| `differential.json` | a few thousand random values, each spelled as a non-canonical JSON text, with the canonical text and id the kernel gives the value (fixed seed; no lone surrogates, no non-finite numbers, which both sides refuse) | the same |
| `frozen.json` | one record of each kind whose bytes are frozen (the claim, the run, the attestation) at its current version, with every optional field and without, and the canonical text and id the kernel gives it; the kernel mints each today and a verifier reads each with no error | `pnpm --filter @musai/records conformance` |
| `references.json` | per record kind, the paths that hold record ids, the id-shaped paths that do not, the subtrees whose strings are data, and the paths that hold blob ids | the same |
| `bundles.json`, `bundles/` | bundles in the export layout, one passing and the rest each changed one way, with the verdict and the exact finding codes a verifier must produce | `pnpm --filter @musai/trust conformance` |
| `digests.json` | each bundle's digest: the SHA-256 of what `sha256sum` prints over its files sorted by path, which both implementations compute | the same |
| `exports.json`, `exports/` | archives the kernel's own `musai export` wrote, each a gzipped tar of a released closure, with the verdict, the codes and the digest a verifier must give it | `pnpm --filter @musai/distribution conformance` |
| `roles.json` | the actions each shipped role grants at scope `any`, and those an empty trust branch grants everyone | `pnpm --filter @musai/trust conformance` |
| `audiences.json` | one `audiences` file and, for every ordered pair of the audiences it names plus `public` and a key and an identity outside it, whether a release to the first covers the second | the same |
| `releases.json`, `releases/` | bundles carrying releases (one set relayed through a model), revocations, seals of either extent and one written with an extent the kernel never mints, a manifest and the three trust files, with the integrity verdict, the entitlement verdict (`covered`, `uncovered` or `unchecked`) and the exact codes a verifier must produce | the same |

A path in `references.json` is `$` followed by `.name` and `[*]` steps, every
array index written as `[*]`. Paths are the union over every schema version a
stored record may declare: a verifier reads stored bytes and never normalises.

A reference's `role` is `citation` when its target must be in the bundle and
`pin` when a distribution may hold it instead (a case's preset names the module
record the kernel resolved at booking). A reference with `grammar: "receipts"`
holds text whose trailing `## Receipts` section defines anchors as record ids.
An id-shaped string (the whole string matching `idPattern`) at no listed path
and under no `opaque` subtree is a finding: a new field that carries an id
cannot slip past the table.
