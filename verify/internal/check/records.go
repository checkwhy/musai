package check

import (
	"bytes"
	"encoding/json/v2"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strings"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/refs"
	"golang.org/x/text/unicode/norm"
)

// File is one file read from under records/, or the error reading it.
type File struct {
	Path string
	Data []byte
	Err  error
}

// Tree is every file under a source's records/ directory, sorted by path.
type Tree struct {
	Files []File
}

// Load reads every regular file under records/. A source with no records
// directory loads as an empty tree. A file whose bytes cannot be read, as
// in a zip damaged in transit, is kept with its error for the checks to
// report; only a directory that cannot be listed fails the load.
func Load(fsys fs.FS) (*Tree, error) {
	tree := &Tree{}
	if _, err := fs.Stat(fsys, "records"); err != nil {
		return tree, nil
	}
	err := fs.WalkDir(fsys, "records", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		data, err := fs.ReadFile(fsys, path)
		tree.Files = append(tree.Files, File{Path: path, Data: data, Err: err})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("reading the records: %w", err)
	}
	slices.SortFunc(tree.Files, func(a, b File) int { return strings.Compare(a.Path, b.Path) })
	return tree, nil
}

func (t *Tree) recordFiles() int {
	count := 0
	for _, file := range t.Files {
		if recordPath.MatchString(file.Path) {
			count++
		}
	}
	return count
}

func (t *Tree) file(path string) (File, bool) {
	i, found := slices.BinarySearchFunc(t.Files, path, func(f File, p string) int { return strings.Compare(f.Path, p) })
	if !found {
		return File{}, false
	}
	return t.Files[i], true
}

var (
	recordPath  = regexp.MustCompile(`^records/([^/]+)/([^/]+)/([^/]+)/([0-9a-f]{64})\.json$`)
	sidecarPath = regexp.MustCompile(`^records/[^/]+/[^/]+/[^/]+/[0-9a-f]{64}\.json\.sig$`)
)

// Record is a record the source holds under its own id: its bytes
// digest, canonically, to the id its path names.
type Record struct {
	ID    string
	Path  string
	Kind  string
	Bytes []byte
	Value map[string]any
}

// Index is the records a source holds, by id.
type Index struct {
	Records map[string]*Record
}

// Sorted returns the held records in id order.
func (x *Index) Sorted() []*Record {
	out := make([]*Record, 0, len(x.Records))
	for _, record := range x.Records {
		out = append(out, record)
	}
	slices.SortFunc(out, func(a, b *Record) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// Records checks every file under records/: that a record is readable
// JSON of a known kind, stored as its own canonical bytes, at the path its
// kind and id name. A record whose canonical bytes digest to another id
// than its path names is not held under either.
func Records(tree *Tree, table refs.Table) (*Index, []Finding) {
	index := &Index{Records: map[string]*Record{}}
	var findings []Finding
	if tree.recordFiles() == 0 {
		findings = append(findings, Finding{Code: "source.empty", Severity: Error, Path: "records", Detail: "the source holds no record, so nothing was verified"})
	}
	for _, file := range tree.Files {
		if file.Err != nil {
			findings = append(findings, unreadable(file.Path, file.Err))
			continue
		}
		if sidecarPath.MatchString(file.Path) {
			continue
		}
		match := recordPath.FindStringSubmatch(file.Path)
		if match == nil {
			findings = append(findings, Finding{Code: "record.stray", Severity: Warning, Path: file.Path, Detail: "a file under records/ that is neither a record nor a signature"})
			continue
		}
		record, problems := readRecord(file, match, table)
		findings = append(findings, problems...)
		if record != nil {
			if _, seen := index.Records[record.ID]; !seen {
				index.Records[record.ID] = record
			}
		}
	}
	return index, findings
}

func readRecord(file File, match []string, table refs.Table) (*Record, []Finding) {
	dirKind, first, second, hex := match[1], match[2], match[3], match[4]
	pathID := "sha256:" + hex
	unreadable := func(detail string) []Finding {
		return []Finding{{Code: "record.unreadable", Severity: Error, Path: file.Path, Record: pathID, Detail: detail}}
	}
	var value map[string]any
	if err := json.Unmarshal(file.Data, &value); err != nil {
		return nil, unreadable("not a JSON object in UTF-8 with distinct keys: " + err.Error())
	}
	kind, _ := value["kind"].(string)
	if _, known := table.Kinds[kind]; !known {
		return nil, unreadable(fmt.Sprintf("kind %q is not a record kind", kind))
	}
	if kind == "attestation" {
		if problem := attestationProblem(value); problem != "" {
			return nil, unreadable("an attestation the kernel would not hold: " + problem)
		}
	}
	id, canonical, err := canon.RecordID(file.Data)
	if err != nil {
		return nil, unreadable(err.Error())
	}
	var findings []Finding
	if !bytes.Equal(canonical, file.Data) {
		findings = append(findings, Finding{Code: "record.not-canonical", Severity: Error, Path: file.Path, Record: id, Detail: "the stored bytes are not their own RFC 8785 canonical form"})
	}
	if id != pathID {
		return nil, append(findings, Finding{Code: "record.id-mismatch", Severity: Error, Path: file.Path, Record: pathID, Detail: "the canonical bytes digest to " + id})
	}
	for _, statement := range table.Kinds[kind].Statements {
		if slices.ContainsFunc(refs.At(value, statement.Path), uncomposed) {
			findings = append(findings, Finding{Code: "record.not-nfc", Severity: Error, Path: file.Path, Record: id, Detail: "the text at " + statement.Path + " is not in Unicode NFC, which the kernel requires of a statement"})
		}
	}
	if dirKind != kind || first != hex[:2] || second != hex[2:4] {
		findings = append(findings, Finding{Code: "record.path-mismatch", Severity: Error, Path: file.Path, Record: id, Detail: fmt.Sprintf("a %s record belongs at records/%s/%s/%s/%s.json", kind, kind, hex[:2], hex[2:4], hex)})
	}
	if version, unknown := unknownVersion(value); kind == "attestation" && unknown {
		findings = append(findings, Finding{Code: "attestation.version-unknown", Severity: Warning, Path: file.Path, Record: id, Detail: fmt.Sprintf("skipped: a %s attestation of schemaVersion %v, a version this verifier does not know, counts for nothing", value["purpose"], version)})
	}
	return &Record{ID: id, Path: file.Path, Kind: kind, Bytes: file.Data, Value: value}, findings
}

// unreadable reports a file of the source whose bytes could not be read.
func unreadable(path string, err error) Finding {
	return Finding{Code: "source.unreadable", Severity: Error, Path: path, Detail: "the source holds this file but its bytes cannot be read: " + err.Error()}
}

// uncomposed reports whether a decoded JSON value holds a string or a key
// outside NFC.
func uncomposed(value any) bool {
	switch v := value.(type) {
	case string:
		return !norm.NFC.IsNormalString(v)
	case []any:
		return slices.ContainsFunc(v, uncomposed)
	case map[string]any:
		for key, entry := range v {
			if !norm.NFC.IsNormalString(key) || uncomposed(entry) {
				return true
			}
		}
	}
	return false
}
