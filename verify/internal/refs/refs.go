// Package refs reads the reference table: which paths of each record kind
// hold record ids, which hold id-shaped strings that are not, which
// subtrees are data a person or a tool wrote, and which paths hold blob
// ids. The table is conformance/references.json, embedded here byte for
// byte.
package refs

import (
	_ "embed"
	"encoding/json/v2"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

//go:embed references.json
var embedded []byte

// Role says whether a reference's target must be held by the source.
type Role string

const (
	// Citation is a reference whose target must be in the source.
	Citation Role = "citation"
	// Pin is a reference a distribution may hold instead of the source.
	Pin Role = "pin"
)

// Reference is a path whose value is a record id.
type Reference struct {
	Path string `json:"path"`
	// Kinds are the kinds the target may be; empty admits any.
	Kinds []string `json:"kinds"`
	Role  Role     `json:"role"`
	// Grammar is "receipts" where the path holds text whose trailing
	// receipts section defines anchors as record ids, and "digest" where it
	// holds a record's digest as bare hex.
	Grammar string `json:"grammar,omitempty"`
}

// Annotated is a path with the reason the table lists it.
type Annotated struct {
	Path string `json:"path"`
	Why  string `json:"why"`
}

// Condition holds when some value at Path equals Equals.
type Condition struct {
	Path   string `json:"path"`
	Equals string `json:"equals"`
}

// Blob is a path whose value is a blob id, where When holds.
type Blob struct {
	Path string     `json:"path"`
	When *Condition `json:"when,omitempty"`
}

// KindTable is the table for one record kind.
type KindTable struct {
	References    []Reference `json:"references"`
	NonReferences []Annotated `json:"nonReferences"`
	Opaque        []Annotated `json:"opaque"`
	Blobs         []Blob      `json:"blobs"`
	// Statements are subtrees whose every string and key is held in NFC.
	Statements []Annotated `json:"statements"`
}

// Table is the whole reference table.
type Table struct {
	IDPattern string               `json:"idPattern"`
	Kinds     map[string]KindTable `json:"kinds"`
}

// Load returns the embedded table.
func Load() (Table, error) {
	var table Table
	if err := json.Unmarshal(embedded, &table); err != nil {
		return Table{}, fmt.Errorf("reading the reference table: %w", err)
	}
	return table, nil
}

// Class is what the table says a path holds.
type Class int

const (
	// ClassUnlisted is a path the table does not name.
	ClassUnlisted Class = iota
	// ClassReference is a path holding a record id.
	ClassReference
	// ClassNonReference is a path holding an id-shaped string that is not a record id.
	ClassNonReference
	// ClassBlob is a path holding a blob id.
	ClassBlob
	// ClassOpaque is a path inside a subtree whose strings are data.
	ClassOpaque
)

func (c Class) String() string {
	return [...]string{"unlisted", "reference", "non-reference", "blob", "opaque"}[c]
}

var index = regexp.MustCompile(`\[\d+\]`)

// Normalise writes every array index of a concrete path as [*].
func Normalise(path string) string {
	return index.ReplaceAllString(path, "[*]")
}

func under(path, subtree string) bool {
	return path == subtree || strings.HasPrefix(path, subtree+".") || strings.HasPrefix(path, subtree+"[")
}

// Classify says what a normalised path of this kind holds. A reference
// read through a grammar names text, not an id, so its path is classed by
// the other lists.
func (k KindTable) Classify(path string) Class {
	switch {
	case slices.ContainsFunc(k.References, func(r Reference) bool { return r.Path == path && r.Grammar == "" }):
		return ClassReference
	case slices.ContainsFunc(k.NonReferences, func(a Annotated) bool { return a.Path == path }):
		return ClassNonReference
	case slices.ContainsFunc(k.Blobs, func(b Blob) bool { return b.Path == path }):
		return ClassBlob
	case slices.ContainsFunc(k.Opaque, func(a Annotated) bool { return under(path, a.Path) }):
		return ClassOpaque
	}
	return ClassUnlisted
}

// Strings calls visit for every string in a decoded JSON value with its
// concrete path, members in key order.
func Strings(value any, visit func(path, s string)) {
	walk(value, "$", visit)
}

func walk(value any, path string, visit func(path, s string)) {
	switch v := value.(type) {
	case string:
		visit(path, v)
	case []any:
		for i, entry := range v {
			walk(entry, path+"["+strconv.Itoa(i)+"]", visit)
		}
	case map[string]any:
		for _, key := range slices.Sorted(mapKeys(v)) {
			walk(v[key], path+"."+key, visit)
		}
	}
}

func mapKeys(m map[string]any) func(func(string) bool) {
	return func(yield func(string) bool) {
		for key := range m {
			if !yield(key) {
				return
			}
		}
	}
}

// At returns every value a table path reaches in a decoded JSON value, in
// order; a step that does not exist reaches nothing.
func At(value any, path string) []any {
	current := []any{value}
	for _, step := range steps(path) {
		var next []any
		for _, v := range current {
			if step == "[*]" {
				if array, ok := v.([]any); ok {
					next = append(next, array...)
				}
				continue
			}
			if object, ok := v.(map[string]any); ok {
				if member, ok := object[step]; ok {
					next = append(next, member)
				}
			}
		}
		current = next
	}
	return current
}

func steps(path string) []string {
	var out []string
	rest := strings.TrimPrefix(path, "$")
	for rest != "" {
		if strings.HasPrefix(rest, "[*]") {
			out = append(out, "[*]")
			rest = rest[3:]
			continue
		}
		rest = strings.TrimPrefix(rest, ".")
		end := strings.IndexAny(rest, ".[")
		if end == -1 {
			end = len(rest)
		}
		out = append(out, rest[:end])
		rest = rest[end:]
	}
	return out
}

var (
	receiptsHeading   = regexp.MustCompile(`(?m)^## Receipts\s*$`)
	receiptDefinition = regexp.MustCompile(`(?m)^\[\^([0-9a-f]{12}(?::[^\]]+)?)\]:\s*(\S+)\s*$`)
	recordID          = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// ReceiptAnchors returns the record ids the definition lines of a text's
// trailing receipts section name, in order, leaving out any definition
// that is not an id.
func ReceiptAnchors(text string) []string {
	heading := receiptsHeading.FindStringIndex(text)
	if heading == nil {
		return nil
	}
	var ids []string
	for _, match := range receiptDefinition.FindAllStringSubmatch(text[heading[1]:], -1) {
		if recordID.MatchString(match[2]) {
			ids = append(ids, match[2])
		}
	}
	return ids
}

// Targets returns the record ids a reference names in a decoded record:
// the ids at its path, the receipt anchors of the text there, or the ids
// its bare digests spell.
func Targets(value any, reference Reference) []string {
	var ids []string
	for _, v := range At(value, reference.Path) {
		s, ok := v.(string)
		switch {
		case !ok:
		case reference.Grammar == "receipts":
			ids = append(ids, ReceiptAnchors(s)...)
		case reference.Grammar == "digest":
			if recordID.MatchString("sha256:" + s) {
				ids = append(ids, "sha256:"+s)
			}
		case recordID.MatchString(s):
			ids = append(ids, s)
		}
	}
	return ids
}
