# The previous-versions attestation, signed under musai

`records/attestation/42/eb/42eb14cc….json.sig` is a detached signature over the stored bytes of
`../previous-versions/records/attestation/42/eb/42eb14cc….json`, made under the `musai` namespace
by a throwaway ed25519 key whose public half is the one line in `allowed-signers`. The private half
was destroyed; nothing here needs to sign again.
