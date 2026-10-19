package check

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"time"

	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/release"
	"github.com/checkwhy/musai/verify/internal/source"
)

// Entitlement says whom a bundle was cut for and how much of it a
// standing release covers there; it never changes the integrity verdict.
type Entitlement struct {
	// Checked is false where the bundle names no audience to check against.
	Checked   bool
	Audience  string
	Covered   int
	Total     int
	audiences release.Audiences
}

// Member reports whether a receiver, a key or an identity, belongs to the
// audience the bundle was cut for.
func (e *Entitlement) Member(as string) Finding {
	if e.Checked && e.audiences.Covers(e.Audience, as) {
		return Finding{Code: "release.member", Severity: Info, Path: "bundle.json", Detail: as + " is in " + e.Audience}
	}
	return Finding{Code: "release.not-member", Severity: Warning, Path: "bundle.json", Detail: as + " is not in the audience this bundle was cut for, " + e.Audience}
}

type manifest struct {
	Root     string `json:"root"`
	Audience string `json:"audience"`
	At       string `json:"at"`
}

func unchecked(detail string) ([]Finding, *Entitlement) {
	return []Finding{{Code: "release.unchecked", Severity: Info, Path: "bundle.json", Detail: detail}}, &Entitlement{}
}

func trustFile(trust fs.FS, name string) (string, error) {
	data, err := fs.ReadFile(trust, name)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(data), err
}

// Entitle reads the bundle's manifest and trust files and reports, for the
// audience the bundle was cut for, which records a standing release covers.
// Signatures are read from the findings the signature check already made.
func Entitle(src *source.Source, index *Index, table refs.Table, signatureFindings []Finding) ([]Finding, *Entitlement) {
	data, err := fs.ReadFile(src.Bundle, "bundle.json")
	if err != nil {
		return unchecked("no bundle.json names the audience the bundle was cut for, so what it may be used for is not checked")
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return unchecked("bundle.json does not parse: " + err.Error())
	}
	at, err := time.Parse(time.RFC3339Nano, m.At)
	if err != nil {
		return unchecked("bundle.json names no RFC 3339 time it was cut at")
	}
	signersText, err := trustFile(src.Trust, "allowed-signers")
	if err != nil {
		return unchecked("allowed-signers cannot be read: " + err.Error())
	}
	rolesText, err := trustFile(src.Trust, "roles")
	if err != nil {
		return unchecked("roles cannot be read: " + err.Error())
	}
	roles, err := release.ParseRoles(rolesText, noSigners(signersText))
	if err != nil {
		return unchecked("roles does not parse: " + err.Error())
	}
	audiencesText, err := trustFile(src.Trust, "audiences")
	if err != nil {
		return unchecked("audiences cannot be read: " + err.Error())
	}
	audiences, err := release.ParseAudiences(audiencesText)
	if err != nil {
		return unchecked("audiences does not parse: " + err.Error())
	}

	verified := map[string]bool{}
	for _, f := range signatureFindings {
		if f.Code == "sig.verified" {
			verified[f.Record] = true
		}
	}
	var attestations []release.Attestation
	var covered []*Record
	for _, record := range index.Sorted() {
		if record.Kind == "attestation" {
			if a, ok := release.FromRecord(record.ID, record.Path, record.Value, verified[record.ID]); ok {
				attestations = append(attestations, a)
				continue
			}
		}
		covered = append(covered, record)
	}

	var findings []Finding
	for _, a := range attestations {
		if a.Purpose != "released" {
			continue
		}
		if release.Form(a.Audience) == "" {
			findings = append(findings, Finding{Code: "release.audience-unknown", Severity: Warning, Path: a.Path, Record: a.ID, Detail: fmt.Sprintf("released to %q, a form of audience this verifier does not know; it covers nothing here", a.Audience)})
		}
		if a.Via == "model" {
			findings = append(findings, Finding{Code: "release.relayed", Severity: Warning, Path: a.Path, Record: a.ID, Detail: "relayed through a model, so the release stands for no audience: a release is a person's"})
		}
		if a.Signed && !roles.HoldsPublish(a.Principal) {
			findings = append(findings, Finding{Code: "release.unauthorised", Severity: Warning, Path: a.Path, Record: a.ID, Detail: a.Principal + " holds no publish in the bundle's roles, so the release stands for no audience"})
		}
	}
	reach := reachOf(index, table)
	var covering []release.Attestation
	for _, a := range release.Standing(attestations, roles) {
		if !audiences.Covers(a.Audience, m.Audience) {
			continue
		}
		if !a.Holds(at) {
			findings = append(findings, Finding{Code: "release.window", Severity: Warning, Path: a.Path, Record: a.ID, Detail: fmt.Sprintf("its window does not hold at %s, checked against the sender's time", m.At)})
			continue
		}
		covering = append(covering, a)
		findings = append(findings, Finding{Code: "release.covered", Severity: Info, Path: a.Path, Record: a.ID, Detail: describe(a)})
	}
	entitlement := &Entitlement{Checked: true, Audience: m.Audience, Total: len(covered), audiences: audiences}
	for _, record := range covered {
		if coveredBy(record.ID, covering, reach) {
			entitlement.Covered++
			continue
		}
		findings = append(findings, Finding{Code: "release.uncovered", Severity: Warning, Path: record.Path, Record: record.ID, Detail: "no standing release in the bundle covers it for " + m.Audience})
	}
	return findings, entitlement
}

func noSigners(text string) bool {
	for line := range strings.SplitSeq(text, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return false
		}
	}
	return true
}

func describe(a release.Attestation) string {
	window := "with no window"
	if a.From != nil || a.Until != nil {
		from, until := "open", "open"
		if a.From != nil {
			from = a.From.Format(time.RFC3339)
		}
		if a.Until != nil {
			until = a.Until.Format(time.RFC3339)
		}
		window = "from " + from + " until " + until
	}
	marking := "no marking"
	if a.Marking != "" {
		marking = "marked " + a.Marking
	}
	return fmt.Sprintf("released by %s to %s, its %s, for %s, %s, %s", a.Principal, a.Audience, a.Extent, strings.Join(a.Uses, ", "), marking, window)
}

// reachOf answers, for each held record, every held record it reaches
// through the citations the reference table names, itself included.
func reachOf(index *Index, table refs.Table) map[string]map[string]bool {
	cites := map[string][]string{}
	for _, record := range index.Sorted() {
		for _, reference := range table.Kinds[record.Kind].References {
			if reference.Role != refs.Citation {
				continue
			}
			cites[record.ID] = append(cites[record.ID], refs.Targets(record.Value, reference)...)
		}
	}
	reach := map[string]map[string]bool{}
	for id := range index.Records {
		reached := map[string]bool{}
		pending := []string{id}
		for len(pending) > 0 {
			next := pending[len(pending)-1]
			pending = pending[:len(pending)-1]
			if reached[next] || index.Records[next] == nil {
				continue
			}
			reached[next] = true
			pending = append(pending, cites[next]...)
		}
		reach[id] = reached
	}
	return reach
}

func coveredBy(id string, covering []release.Attestation, reach map[string]map[string]bool) bool {
	for _, a := range covering {
		if a.Subject == id || (a.Extent == "closure" && reach[a.Subject][id]) {
			return true
		}
	}
	return false
}
