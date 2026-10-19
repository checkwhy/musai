package check_test

import (
	"encoding/json"
	"maps"
	"strings"
	"testing"
	"testing/fstest"
)

const cited = "sha256:0000000000000000000000000000000000000000000000000000000000000001"

const keyPrincipal = "key:SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"

type fields = map[string]any

// absent, set over a field, leaves it out of the record.
type absentField struct{}

var absent = absentField{}

func release(uses []string, marking any) fields {
	return fields{"form": "bytes", "uses": uses, "from": nil, "until": nil, "marking": marking}
}

// window is terms for a review with the bounds given.
func window(from, until any) fields {
	terms := release([]string{"review"}, nil)
	terms["from"], terms["until"] = from, until
	return terms
}

func without(terms fields, key string) fields {
	delete(terms, key)
	return terms
}

func released(terms fields) fields {
	return fields{"purpose": "released", "audience": "peer", "extent": "record", "terms": terms}
}

// attestation is a made attestation with the fields set over it.
func attestation(t *testing.T, set fields) string {
	t.Helper()
	record := fields{
		"kind":           "attestation",
		"schemaVersion":  5,
		"subject":        cited,
		"principal":      "florin",
		"principalClass": "person",
		"via":            "signature",
		"purpose":        "made",
		"at":             "2026-09-01T00:00:00.000Z",
		"supersedes":     []string{},
	}
	maps.Copy(record, set)
	for key, value := range record {
		if value == absent {
			delete(record, key)
		}
	}
	text, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestAnAttestationBreakingTheKernelsContractIsNoRecordHeld(t *testing.T) {
	for name, set := range map[string]fields{
		"a seal naming extent record":          {"purpose": "sealed", "seal": fields{"audience": "peer", "extent": "record"}},
		"a seal relayed through a model":       {"purpose": "sealed", "via": "model", "seal": fields{"audience": "peer"}},
		"a seal carrying a release field":      {"purpose": "sealed", "seal": fields{"audience": "peer"}, "extent": "closure"},
		"a seal on a made attestation":         {"seal": fields{"audience": "peer"}},
		"a release naming a class":             {"purpose": "released", "audience": "peer", "extent": "record", "terms": release([]string{"review"}, nil), "class": "x"},
		"a release with an unknown extent":     {"purpose": "released", "audience": "peer", "extent": "all", "terms": release([]string{"review"}, nil)},
		"a release granting republish":         {"purpose": "released", "audience": "peer", "extent": "record", "terms": release([]string{"republish"}, nil)},
		"a release whose uses are unordered":   {"purpose": "released", "audience": "peer", "extent": "record", "terms": release([]string{"cite", "review"}, nil)},
		"a release whose marking is malformed": {"purpose": "released", "audience": "peer", "extent": "record", "terms": release([]string{"review"}, "SPDX MIT")},
		"a made attestation with an audience":  {"audience": "peer"},
		"a revocation withdrawing nothing":     {"purpose": "revoked"},
		"an unknown purpose":                   {"purpose": "endorsed"},
		"an unknown channel":                   {"via": "telepathy"},
		"a zoneless time":                      {"at": "2026-09-01T00:00:00"},
		"a release with no until":              released(without(window(nil, nil), "until")),
		"a release with no from":               released(without(window(nil, nil), "from")),
		"a release with no marking":            released(without(release([]string{"review"}, nil), "marking")),
		"a release whose window is inverted":   released(window("2026-09-02T00:00:00Z", "2026-09-01T00:00:00Z")),
		"a release to an audience not a form":  {"purpose": "released", "audience": "group:crew", "extent": "record", "terms": release([]string{"review"}, nil)},
		"a seal to an audience not a form":     {"purpose": "sealed", "seal": fields{"audience": "group:crew"}},
		"a seal that is no object":             {"purpose": "sealed", "seal": "peer"},
		"a marking with a no-break space":      released(release([]string{"review"}, "spdx:MIT\u00a0X")),
		"a malformed pseudonym":                {"principal": "pseudonym:abc"},
		"a current one naming a bare name":     {"schemaVersion": 6, "principal": "florin"},
		"a current one naming a short key":     {"schemaVersion": 6, "principal": "key:SHA256:short"},
		"no subject":                           {"subject": absent},
		"a supersedes that is no array":        {"supersedes": "none"},
		"a supersedes naming no record":        {"supersedes": []string{"nothing"}},
		"no schema version":                    {"schemaVersion": absent},
		"a version no normaliser reaches":      {"schemaVersion": 1},
	} {
		fsys := fstest.MapFS{}
		put(t, fsys, "attestation", attestation(t, set))
		if result := run(t, fsys); !hasCode(result, "record.unreadable") {
			t.Errorf("%s: findings %+v", name, result.Findings)
		}
	}
}

func TestAnAttestationTheKernelHoldsIsRead(t *testing.T) {
	for name, set := range map[string]fields{
		"a made attestation":                {},
		"a seal of the record alone":        {"purpose": "sealed", "seal": fields{"audience": "peer"}},
		"a seal of the closure":             {"purpose": "sealed", "seal": fields{"audience": "peer", "extent": "closure"}},
		"a release granting republish spdx": {"purpose": "released", "audience": "peer", "extent": "closure", "terms": release([]string{"review", "republish"}, "spdx:MIT")},
		"a revocation":                      {"purpose": "revoked", "supersedes": []string{cited}},
		"a version before supersedes":       {"schemaVersion": 2, "supersedes": absent},
		"a later version's purpose":         {"schemaVersion": 7, "purpose": "endorsed"},
		"a later version's audience form":   {"schemaVersion": 7, "purpose": "released", "audience": "group:crew", "extent": "record", "terms": release([]string{"review"}, nil)},
		"a current one naming a key":        {"schemaVersion": 6, "principal": keyPrincipal},
		"a current one naming a pseudonym":  {"schemaVersion": 6, "principal": "pseudonym:k:" + strings.Repeat("0", 64)},
		"an earlier one naming a name":      {"schemaVersion": 5, "principal": "florin"},
	} {
		fsys := fstest.MapFS{}
		put(t, fsys, "attestation", attestation(t, set))
		if result := run(t, fsys); hasCode(result, "record.unreadable") {
			t.Errorf("%s: findings %+v", name, result.Findings)
		}
	}
}
