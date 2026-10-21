// Package conformance runs the corpus the kernel writes to conformance/
// against this verifier: the canonical vectors, the differential corpus,
// the frozen kinds, the reference table, the bundles, the bundles carrying releases and the
// kernel's own exports, each case passing or failing.
package conformance

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io/fs"
	"slices"
	"testing/fstest"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// Case is one conformance case's outcome.
type Case struct {
	Suite  string `json:"suite"`
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail,omitempty"`
}

// Run runs every suite in a conformance directory. An error is the corpus
// failing to be read, never a case failing.
func Run(dir fs.FS) ([]Case, error) {
	var cases []Case
	for _, suite := range []func(fs.FS) ([]Case, error){canonical, differential, frozen, references, bundles, releases, exports} {
		found, err := suite(dir)
		if err != nil {
			return nil, err
		}
		cases = append(cases, found...)
	}
	return cases, nil
}

func read(dir fs.FS, name string, into any) error {
	data, err := fs.ReadFile(dir, name)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, into); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func canonical(dir fs.FS) ([]Case, error) {
	var rows []struct {
		Name      string         `json:"name"`
		Input     jsontext.Value `json:"input"`
		Canonical string         `json:"canonical"`
		ID        string         `json:"id"`
	}
	if err := read(dir, "canonical.json", &rows); err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(rows))
	for _, row := range rows {
		id, bytes, err := canon.RecordID(row.Input)
		c := Case{Suite: "canonical", Name: row.Name, Passed: err == nil && string(bytes) == row.Canonical && id == row.ID}
		if !c.Passed {
			c.Detail = fmt.Sprintf("got %s %s (%v), want %s %s", bytes, id, err, row.Canonical, row.ID)
		}
		cases = append(cases, c)
	}
	return cases, nil
}

func differential(dir fs.FS) ([]Case, error) {
	var corpus struct {
		Cases []struct {
			Text      string `json:"text"`
			Canonical string `json:"canonical"`
			ID        string `json:"id"`
		} `json:"cases"`
	}
	if err := read(dir, "differential.json", &corpus); err != nil {
		return nil, err
	}
	var failed []int
	for i, entry := range corpus.Cases {
		id, bytes, err := canon.RecordID([]byte(entry.Text))
		if err != nil || string(bytes) != entry.Canonical || id != entry.ID {
			failed = append(failed, i)
		}
	}
	c := Case{Suite: "differential", Name: fmt.Sprintf("%d values", len(corpus.Cases)), Passed: len(failed) == 0}
	if !c.Passed {
		c.Detail = fmt.Sprintf("%d disagree, first at case %d", len(failed), failed[0])
	}
	return []Case{c}, nil
}

// frozen holds each record of a kind whose bytes are frozen: its canonical
// text and id are the kernel's, and this verifier reads it with no error.
func frozen(dir fs.FS) ([]Case, error) {
	var corpus struct {
		Cases []struct {
			Name      string         `json:"name"`
			Kind      string         `json:"kind"`
			Record    jsontext.Value `json:"record"`
			Canonical string         `json:"canonical"`
			ID        string         `json:"id"`
		} `json:"cases"`
	}
	if err := read(dir, "frozen.json", &corpus); err != nil {
		return nil, err
	}
	table, err := refs.Load()
	if err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(corpus.Cases))
	for _, row := range corpus.Cases {
		c := Case{Suite: "frozen", Name: row.Name}
		id, text, err := canon.RecordID(row.Record)
		if err != nil || string(text) != row.Canonical || id != row.ID {
			c.Detail = fmt.Sprintf("got %s %s (%v), want %s %s", text, id, err, row.Canonical, row.ID)
			cases = append(cases, c)
			continue
		}
		hex := canon.Hex(id)
		path := fmt.Sprintf("records/%s/%s/%s/%s.json", row.Kind, hex[:2], hex[2:4], hex)
		tree, err := check.Load(fstest.MapFS{path: &fstest.MapFile{Data: text}})
		if err != nil {
			return nil, err
		}
		_, findings := check.Records(tree, table)
		var errors []string
		for _, finding := range findings {
			if finding.Severity == check.Error {
				errors = append(errors, finding.Code+": "+finding.Detail)
			}
		}
		c.Passed = len(errors) == 0
		if !c.Passed {
			c.Detail = fmt.Sprint(errors)
		}
		cases = append(cases, c)
	}
	return cases, nil
}

// references compares the table this verifier embeds with the corpus's,
// as decoded tables in canonical form, so a verifier built from an older
// copy is caught whatever the file's layout.
func references(dir fs.FS) ([]Case, error) {
	shared, err := fs.ReadFile(dir, "references.json")
	if err != nil {
		return nil, err
	}
	var sharedTable refs.Table
	if err := json.Unmarshal(shared, &sharedTable); err != nil {
		return nil, fmt.Errorf("references.json: %w", err)
	}
	embeddedTable, err := refs.Load()
	if err != nil {
		return nil, err
	}
	same, err := sameCanonical(embeddedTable, sharedTable)
	if err != nil {
		return nil, err
	}
	c := Case{Suite: "references", Name: "the table this verifier embeds", Passed: same}
	if !c.Passed {
		c.Detail = "the embedded table differs from references.json"
	}
	return []Case{c}, nil
}

func sameCanonical(a, b refs.Table) (bool, error) {
	var forms [2][]byte
	for i, table := range []refs.Table{a, b} {
		data, err := json.Marshal(table)
		if err != nil {
			return false, err
		}
		if forms[i], err = canon.Canonical(data); err != nil {
			return false, err
		}
	}
	return bytes.Equal(forms[0], forms[1]), nil
}

func bundles(dir fs.FS) ([]Case, error) {
	var rows []struct {
		Name    string   `json:"name"`
		Verdict string   `json:"verdict"`
		Codes   []string `json:"codes"`
	}
	if err := read(dir, "bundles.json", &rows); err != nil {
		return nil, err
	}
	var digests map[string]string
	if err := read(dir, "digests.json", &digests); err != nil {
		return nil, err
	}
	table, err := refs.Load()
	if err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(rows))
	for _, row := range rows {
		bundle, err := fs.Sub(dir, "bundles/"+row.Name)
		if err != nil {
			return nil, err
		}
		src := &source.Source{Name: row.Name, Bundle: bundle, Trust: bundle, HasBlobs: false}
		got, err := outcome(src, table)
		if err != nil {
			return nil, err
		}
		digest, err := source.Digest(bundle)
		if err != nil {
			return nil, err
		}
		c := Case{
			Suite: "bundles", Name: row.Name,
			Passed: got.verdict == row.Verdict && slices.Equal(got.codes, row.Codes) && digest == digests[row.Name],
		}
		if !c.Passed {
			c.Detail = fmt.Sprintf("%s with %v digesting to %s, want %s with %v digesting to %s",
				got.verdict, got.codes, digest, row.Verdict, row.Codes, digests[row.Name])
		}
		cases = append(cases, c)
	}
	return cases, nil
}

// releases checks each bundle carrying releases, revocations or seals: it
// must answer its row's verdict, entitlement and codes.
func releases(dir fs.FS) ([]Case, error) {
	var rows []struct {
		Name        string   `json:"name"`
		Verdict     string   `json:"verdict"`
		Entitlement string   `json:"entitlement"`
		Codes       []string `json:"codes"`
	}
	if err := read(dir, "releases.json", &rows); err != nil {
		return nil, err
	}
	table, err := refs.Load()
	if err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(rows))
	for _, row := range rows {
		bundle, err := fs.Sub(dir, "releases/"+row.Name)
		if err != nil {
			return nil, err
		}
		src := &source.Source{Name: row.Name, Bundle: bundle, Trust: bundle, HasBlobs: false}
		got, err := outcome(src, table)
		if err != nil {
			return nil, err
		}
		c := Case{
			Suite: "releases", Name: row.Name,
			Passed: got.verdict == row.Verdict && got.entitlement == row.Entitlement && slices.Equal(got.codes, row.Codes),
		}
		if !c.Passed {
			c.Detail = fmt.Sprintf("%s and %s with %v, want %s and %s with %v",
				got.verdict, got.entitlement, got.codes, row.Verdict, row.Entitlement, row.Codes)
		}
		cases = append(cases, c)
	}
	return cases, nil
}

// answer is what a source gives under its own trust: its verdict, its
// entitlement and every error and warning code it produced, sorted.
type answer struct {
	verdict     string
	entitlement string
	codes       []string
}

func outcome(src *source.Source, table refs.Table) (answer, error) {
	result, err := check.Run(src, table, trust.Own(src))
	if err != nil {
		return answer{}, err
	}
	got := answer{verdict: "verified", entitlement: "unchecked"}
	if result.Failed() {
		got.verdict = "failed"
	}
	if result.Released.Checked {
		got.entitlement = "uncovered"
		if result.Released.Covered == result.Released.Total {
			got.entitlement = "covered"
		}
	}
	for _, finding := range result.Findings {
		if finding.Severity != check.Info && !slices.Contains(got.codes, finding.Code) {
			got.codes = append(got.codes, finding.Code)
		}
	}
	slices.Sort(got.codes)
	return got, nil
}

// exports checks each archive the kernel's own export wrote: opened as a
// receiver opens it, it must answer its row's verdict and codes and digest
// to its row's digest.
func exports(dir fs.FS) ([]Case, error) {
	var rows []struct {
		Name    string   `json:"name"`
		Archive string   `json:"archive"`
		Verdict string   `json:"verdict"`
		Codes   []string `json:"codes"`
		Digest  string   `json:"digest"`
	}
	if err := read(dir, "exports.json", &rows); err != nil {
		return nil, err
	}
	table, err := refs.Load()
	if err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(rows))
	for _, row := range rows {
		data, err := fs.ReadFile(dir, row.Archive)
		if err != nil {
			return nil, err
		}
		c := Case{Suite: "exports", Name: row.Name}
		src, err := source.FromArchive(data)
		if err != nil {
			c.Detail = err.Error()
			cases = append(cases, c)
			continue
		}
		got, err := outcome(src, table)
		if err != nil {
			return nil, err
		}
		digest, err := source.Digest(src.Bundle)
		if err != nil {
			return nil, err
		}
		c.Passed = got.verdict == row.Verdict && slices.Equal(got.codes, row.Codes) && digest == row.Digest
		if !c.Passed {
			c.Detail = fmt.Sprintf("%s with %v digesting to %s, want %s with %v digesting to %s",
				got.verdict, got.codes, digest, row.Verdict, row.Codes, row.Digest)
		}
		cases = append(cases, c)
	}
	return cases, nil
}
