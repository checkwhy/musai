package release

import (
	"slices"
	"time"
)

// Attestation is a release or a revocation a bundle holds, with whether
// its signature verified.
type Attestation struct {
	ID         string
	Path       string
	Subject    string
	Principal  string
	Via        string
	Purpose    string
	Audience   string
	Extent     string
	Uses       []string
	Marking    string
	From       *time.Time
	Until      *time.Time
	Supersedes []string
	Signed     bool
}

// FromRecord reads a release or a revocation from an attestation's value,
// and reports false for any other purpose.
func FromRecord(id, path string, value map[string]any, signed bool) (Attestation, bool) {
	purpose, _ := value["purpose"].(string)
	if purpose != "released" && purpose != "revoked" {
		return Attestation{}, false
	}
	a := Attestation{ID: id, Path: path, Purpose: purpose, Signed: signed}
	a.Subject, _ = value["subject"].(string)
	a.Principal, _ = value["principal"].(string)
	a.Via, _ = value["via"].(string)
	a.Audience, _ = value["audience"].(string)
	a.Extent, _ = value["extent"].(string)
	a.Supersedes = stringsOf(value["supersedes"])
	if terms, ok := value["terms"].(map[string]any); ok {
		a.Uses = stringsOf(terms["uses"])
		a.Marking, _ = terms["marking"].(string)
		a.From = instant(terms["from"])
		a.Until = instant(terms["until"])
	}
	return a, true
}

func stringsOf(value any) []string {
	items, _ := value.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func instant(value any) *time.Time {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	at, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return nil
	}
	return &at
}

// Holds reports whether the release's window holds at, either end open
// where the release leaves it unset.
func (a Attestation) Holds(at time.Time) bool {
	return (a.From == nil || !at.Before(*a.From)) && (a.Until == nil || at.Before(*a.Until))
}

// Standing answers the releases that stand: each signed by a holder of
// publish, relayed through no model, and neither revoked nor replaced by an
// attestation that counts. No attestation's own time is read.
func Standing(attestations []Attestation, roles Roles) []Attestation {
	var releases []Attestation
	for _, a := range attestations {
		if a.Purpose == "released" && a.Signed && a.Via != "model" && roles.HoldsPublish(a.Principal) {
			releases = append(releases, a)
		}
	}
	withdrawn := map[string]bool{}
	for _, a := range attestations {
		if a.Purpose != "revoked" || !a.Signed || !revocationCounts(a, attestations, roles) {
			continue
		}
		for _, id := range a.Supersedes {
			if slices.ContainsFunc(attestations, func(r Attestation) bool { return r.ID == id && r.Subject == a.Subject }) {
				withdrawn[id] = true
			}
		}
	}
	for _, r := range releases {
		for _, id := range r.Supersedes {
			withdrawn[id] = true
		}
	}
	return slices.DeleteFunc(releases, func(r Attestation) bool { return withdrawn[r.ID] })
}

func revocationCounts(revocation Attestation, attestations []Attestation, roles Roles) bool {
	if roles.HoldsPublish(revocation.Principal) {
		return true
	}
	named := 0
	for _, a := range attestations {
		if a.Purpose == "released" && slices.Contains(revocation.Supersedes, a.ID) {
			if a.Principal != revocation.Principal {
				return false
			}
			named++
		}
	}
	return named > 0
}
