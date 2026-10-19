// Package trace walks the citation graph of a source from one record:
// down through every reference the table names, and up from the rulings,
// arguments and attestations that name a record. It prints what each
// record says of itself and computes nothing about it.
package trace

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/printable"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/sig"
)

// The walk's refusals.
var (
	ErrNoSuchRecord   = errors.New("no record in the source has that id")
	ErrAmbiguous      = errors.New("more than one record starts with that prefix")
	ErrPrefixTooShort = errors.New("an id prefix needs at least eight hex characters")
)

// Node is one record in the walk.
type Node struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Summary string `json:"summary"`
	Edges   []Edge `json:"edges,omitempty"`
}

// Edge is one reference, from this node down or to it from above.
type Edge struct {
	// Path is where the referring record names its target.
	Path string `json:"path"`
	// Inbound is true when the edge's node names this one.
	Inbound bool   `json:"inbound"`
	Target  string `json:"target"`
	// Node is the other record, nil when the source does not hold it.
	Node *Node `json:"node,omitempty"`
	// Seen is true when the other record is shown elsewhere in the walk.
	Seen bool `json:"seen,omitempty"`
}

// The kinds that stand on a record they name: a judgment, an attack and a
// signature. The walk follows these up from every record it reaches.
var standsOn = []string{"ruling", "argument", "attestation"}

// SignatureStates reads, per attestation id, what the checks found of its
// signature.
func SignatureStates(result check.Result) map[string]string {
	states := map[string]string{}
	for _, finding := range result.Findings {
		switch {
		case finding.Code == "sig.verified":
			states[finding.Record] = "signature verified"
		case finding.Code == "sig.absent":
			states[finding.Record] = "unsigned"
		case strings.HasPrefix(finding.Code, "sig."):
			states[finding.Record] = "signature failed (" + finding.Code + ")"
		}
	}
	return states
}

// Resolve reads a full id, or a prefix of its hex of at least eight
// characters with or without the algorithm, as the one held record it names.
func Resolve(index *check.Index, given string) (string, error) {
	if canon.IsID(given) {
		if _, ok := index.Records[given]; ok {
			return given, nil
		}
		return "", fmt.Errorf("%s: %w", given, ErrNoSuchRecord)
	}
	prefix := strings.TrimPrefix(given, "sha256:")
	if len(prefix) < 8 {
		return "", fmt.Errorf("%s: %w", given, ErrPrefixTooShort)
	}
	var matches []string
	for id := range index.Records {
		if strings.HasPrefix(canon.Hex(id), prefix) {
			matches = append(matches, id)
		}
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("%s: %w", given, ErrNoSuchRecord)
	case 1:
		return matches[0], nil
	}
	slices.Sort(matches)
	return "", fmt.Errorf("%s matches %s: %w", given, strings.Join(matches, ", "), ErrAmbiguous)
}

type inboundRef struct {
	from *check.Record
	path string
}

type walker struct {
	index    *check.Index
	table    refs.Table
	sigs     map[string]string
	signers  []sig.Signer
	inbound  map[string][]inboundRef
	expanded map[string]bool
}

// Walk returns the graph reachable from a held record, naming a signer by
// the alias signers lists beside its key.
func Walk(index *check.Index, table refs.Table, id string, signatures map[string]string, signers []sig.Signer) (*Node, error) {
	if _, ok := index.Records[id]; !ok {
		return nil, fmt.Errorf("%s: %w", id, ErrNoSuchRecord)
	}
	w := &walker{index: index, table: table, sigs: signatures, signers: signers, inbound: map[string][]inboundRef{}, expanded: map[string]bool{}}
	for _, record := range index.Sorted() {
		for _, reference := range table.Kinds[record.Kind].References {
			for _, target := range refs.Targets(record.Value, reference) {
				w.inbound[target] = append(w.inbound[target], inboundRef{from: record, path: reference.Path})
			}
		}
	}
	return w.node(index.Records[id], ""), nil
}

func (w *walker) leaf(record *check.Record) *Node {
	return &Node{ID: record.ID, Kind: record.Kind, Summary: summary(record, w.sigs, w.signers)}
}

// node expands a record, leaving out the edges back to the record it was
// reached from.
func (w *walker) node(record *check.Record, from string) *Node {
	n := w.leaf(record)
	w.expanded[record.ID] = true
	for _, reference := range w.table.Kinds[record.Kind].References {
		for _, target := range refs.Targets(record.Value, reference) {
			if target != from {
				n.Edges = append(n.Edges, w.edge(record.ID, reference.Path, false, target, w.index.Records[target], true))
			}
		}
	}
	for _, in := range w.inbound[record.ID] {
		if in.from.ID != from {
			n.Edges = append(n.Edges, w.edge(record.ID, in.path, true, in.from.ID, in.from, slices.Contains(standsOn, in.from.Kind)))
		}
	}
	return n
}

func (w *walker) edge(from, path string, inbound bool, target string, record *check.Record, follow bool) Edge {
	e := Edge{Path: path, Inbound: inbound, Target: target}
	switch {
	case record == nil:
	case w.expanded[record.ID]:
		e.Node, e.Seen = w.leaf(record), true
	case follow:
		e.Node = w.node(record, from)
	default:
		e.Node = w.leaf(record)
	}
	return e
}

// Text renders the walk as an indented tree.
func (n *Node) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s  %s\n", n.Kind, n.ID, printable.String(n.Summary))
	n.write(&b, "")
	return b.String()
}

func (n *Node) write(b *strings.Builder, indent string) {
	for i, e := range n.Edges {
		branch, next := "├─ ", "│  "
		if i == len(n.Edges)-1 {
			branch, next = "└─ ", "   "
		}
		b.WriteString(indent + branch + e.line() + "\n")
		if e.Node != nil && !e.Seen {
			e.Node.write(b, indent+next)
		}
	}
}

func (e Edge) line() string {
	if e.Node == nil {
		return fmt.Sprintf("%s → %s  not in the source", e.Path, e.Target)
	}
	described := fmt.Sprintf("%s %s  %s", e.Node.Kind, short(e.Node.ID), printable.String(e.Node.Summary))
	if e.Seen {
		described = fmt.Sprintf("%s %s  (shown above)", e.Node.Kind, short(e.Node.ID))
	}
	if e.Inbound {
		return fmt.Sprintf("← %s of %s", e.Path, described)
	}
	return fmt.Sprintf("%s → %s", e.Path, described)
}

func short(id string) string {
	return canon.Hex(id)[:12] + "…"
}
