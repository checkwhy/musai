package check

import (
	"encoding/json/v2"
	"strings"
	"time"

	"github.com/checkwhy/musai/verify/internal/sig"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// Signatures verifies every sidecar against the bytes stored beside it and
// the trusted anchors' signers, at the attestation's own time. An
// attestation with no sidecar is reported, not failed: how much signing a
// workspace asks for is the kernel's business. It returns the findings and
// how many signatures verified.
func Signatures(tree *Tree, index *Index, trusted trust.Set) ([]Finding, int) {
	var findings []Finding
	for _, anchor := range trusted {
		if anchor.ReadErr != nil {
			findings = append(findings, unreadable(anchor.Path, anchor.ReadErr))
		}
		for _, problem := range anchor.Problems {
			findings = append(findings, lineRefused(anchor.Path, problem))
		}
	}
	signers := trusted.Signers()
	verified := 0
	signed := map[string]bool{}
	for _, file := range tree.Files {
		if !sidecarPath.MatchString(file.Path) {
			continue
		}
		recordFile, ok := tree.file(strings.TrimSuffix(file.Path, ".sig"))
		signed[recordFile.Path] = ok
		switch {
		case !ok:
			findings = append(findings, Finding{Code: "sig.orphan", Severity: Error, Path: file.Path, Detail: "a signature beside no record"})
			continue
		case file.Err != nil, recordFile.Err != nil:
			continue
		case index.Records["sha256:"+recordPath.FindStringSubmatch(recordFile.Path)[4]] == nil:
			// A record the verifier refused is held under no id, so its signature vouches for nothing.
			continue
		}
		finding := verify(recordFile, file.Data, signers)
		finding.Path = file.Path
		if finding.Code == "sig.verified" {
			verified++
		}
		findings = append(findings, finding)
	}
	for _, record := range index.Sorted() {
		if record.Kind == "attestation" && !signed[record.Path] {
			findings = append(findings, Finding{Code: "sig.absent", Severity: Info, Path: record.Path, Record: record.ID, Detail: "an attestation with no signature beside it"})
		}
	}
	return findings, verified
}

// lineRefused fails a verification on a trust file the kernel would refuse to
// open; a GitHub account's line that is no key is no trust file's, and skipped.
func lineRefused(path string, problem sig.LineError) Finding {
	switch problem.Class {
	case "":
		return Finding{Code: "trust.line-invalid", Severity: Warning, Path: path, Detail: problem.Error() + "; skipped"}
	case sig.RefusedKeyForeign:
		return Finding{Code: "trust.key-mismatch", Severity: Error, Path: path, Detail: problem.Error() + "; the line is not trusted"}
	}
	return Finding{Code: "trust.line-invalid", Severity: Error, Path: path, Detail: problem.Error() + "; the line is not trusted"}
}

func verify(record File, armored []byte, signers []sig.Signer) Finding {
	id := "sha256:" + recordPath.FindStringSubmatch(record.Path)[4]
	principal, at, ok := attested(record.Data)
	if !ok {
		return Finding{Code: sig.CodeMalformed, Severity: Error, Record: id, Detail: "the signed record carries no principal and RFC 3339 time to verify against"}
	}
	outcome := sig.Verify(record.Data, armored, principal, at, signers)
	if outcome.Code == "" {
		return Finding{Code: "sig.verified", Severity: Info, Record: id, Detail: outcome.Detail}
	}
	return Finding{Code: outcome.Code, Severity: Error, Record: id, Detail: outcome.Detail}
}

// attested reads the principal and the time a signed attestation claims.
func attested(data []byte) (string, time.Time, bool) {
	var claimed struct {
		Principal string `json:"principal"`
		At        string `json:"at"`
	}
	if err := json.Unmarshal(data, &claimed); err != nil || claimed.Principal == "" {
		return "", time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, claimed.At)
	if err != nil {
		return "", time.Time{}, false
	}
	return claimed.Principal, at, true
}
