// Package check holds the verifier's checks. Each is a pure function over
// what a source holds and yields findings with stable codes: record ids
// and paths, references, signatures and blobs.
package check

import (
	"cmp"
	"slices"

	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// Severity says what a finding does to the verdict.
type Severity string

const (
	// Error fails the verification.
	Error Severity = "error"
	// Warning is reported and leaves the verdict alone.
	Warning Severity = "warning"
	// Info reports what was checked.
	Info Severity = "info"
)

// Finding is one thing a check found.
type Finding struct {
	Code     string   `json:"code"`
	Severity Severity `json:"severity"`
	// Path is the file in the source the finding is about.
	Path string `json:"path"`
	// Record is the id of the record the finding is about, where one is known.
	Record string `json:"record,omitempty"`
	// At is the path within the record, where the finding is about one value.
	At     string `json:"at,omitempty"`
	Detail string `json:"detail"`
}

// Result is every finding of a verification with what it covered.
type Result struct {
	Findings []Finding
	// Records is the number of record files read.
	Records int
	// Signatures is the number of signatures that verified.
	Signatures int
	// Released is whom the bundle was cut for and how much a release covers.
	Released *Entitlement
}

// Failed reports whether any finding is an error.
func (r Result) Failed() bool {
	return slices.ContainsFunc(r.Findings, func(f Finding) bool { return f.Severity == Error })
}

// Run reads a source and runs every check over it, checking signatures
// against the trusted anchors. A file that cannot be read is a finding; an
// error is the source's records failing to be listed.
func Run(src *source.Source, table refs.Table, trusted trust.Set) (Result, error) {
	tree, err := Load(src.Bundle)
	if err != nil {
		return Result{}, err
	}
	index, findings := Records(tree, table)
	findings = append(findings, References(index, table)...)
	signatures, verified := Signatures(tree, index, trusted)
	findings = append(findings, signatures...)
	findings = append(findings, Blobs(index, table, src.Bundle, src.HasBlobs)...)
	entitlements, released := Entitle(src, index, table, signatures)
	findings = append(findings, entitlements...)
	slices.SortStableFunc(findings, func(a, b Finding) int {
		return cmp.Or(cmp.Compare(a.Path, b.Path), cmp.Compare(a.Code, b.Code), cmp.Compare(a.At, b.At), cmp.Compare(a.Detail, b.Detail))
	})
	return Result{Findings: findings, Records: tree.recordFiles(), Signatures: verified, Released: released}, nil
}
