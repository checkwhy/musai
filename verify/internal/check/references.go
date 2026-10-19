package check

import (
	"fmt"
	"slices"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/refs"
)

// References checks that every record id a held record names at a path
// the table lists resolves to a held record of a kind the table allows
// there, and that no id-shaped string sits at a path the table does not
// name.
func References(index *Index, table refs.Table) []Finding {
	var findings []Finding
	for _, record := range index.Sorted() {
		kind := table.Kinds[record.Kind]
		for _, reference := range kind.References {
			for _, target := range refs.Targets(record.Value, reference) {
				findings = append(findings, resolve(index, record, reference, target)...)
			}
		}
		refs.Strings(record.Value, func(path, s string) {
			if canon.IsID(s) && kind.Classify(refs.Normalise(path)) == refs.ClassUnlisted {
				findings = append(findings, Finding{Code: "ref.unlisted", Severity: Error, Path: record.Path, Record: record.ID, At: path, Detail: "an id at a path the reference table does not name: " + s})
			}
		})
	}
	return findings
}

func resolve(index *Index, record *Record, reference refs.Reference, target string) []Finding {
	held, ok := index.Records[target]
	if !ok {
		if reference.Role == refs.Pin {
			return []Finding{{Code: "ref.pin-absent", Severity: Warning, Path: record.Path, Record: record.ID, At: reference.Path, Detail: target + " is not in the source; a distribution may hold it"}}
		}
		return []Finding{{Code: "ref.dangling", Severity: Error, Path: record.Path, Record: record.ID, At: reference.Path, Detail: target + " is not in the source"}}
	}
	if len(reference.Kinds) > 0 && !slices.Contains(reference.Kinds, held.Kind) {
		return []Finding{{Code: "ref.kind-mismatch", Severity: Error, Path: record.Path, Record: record.ID, At: reference.Path, Detail: fmt.Sprintf("%s is a %s, where the table admits %v", target, held.Kind, reference.Kinds)}}
	}
	return nil
}
