package release_test

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"slices"
	"testing"

	"github.com/checkwhy/musai/verify/internal/release"
)

const conformance = "../../../conformance"

func TestTheEmbeddedRoleTableIsTheConformanceTable(t *testing.T) {
	shared, err := os.ReadFile(conformance + "/roles.json")
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := os.ReadFile("roles.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(shared, embedded) {
		t.Fatal("internal/release/roles.json differs from conformance/roles.json: copy the shared table over it")
	}
}

func TestHoldsPublishExactlyWhereTheKernelsRoleTableGrantsIt(t *testing.T) {
	var table struct {
		Roles map[string][]string `json:"roles"`
	}
	data, _ := os.ReadFile(conformance + "/roles.json")
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	for role, actions := range table.Roles {
		roles, err := release.ParseRoles("p "+role+" any\n", false)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := roles.HoldsPublish("p"), slices.Contains(actions, "publish"); got != want {
			t.Errorf("%s at any: holds publish %v, want %v", role, got, want)
		}
		if roles.HoldsPublish("q") {
			t.Errorf("%s granted to p holds publish for q", role)
		}
	}
	scoped, _ := release.ParseRoles("p owner case-1\n", false)
	if scoped.HoldsPublish("p") {
		t.Error("an owner at a narrower scope than any holds publish")
	}
	empty, _ := release.ParseRoles("", true)
	if !empty.HoldsPublish("anyone") {
		t.Error("an empty trust branch grants no publish")
	}
	signersOnly, _ := release.ParseRoles("", false)
	if signersOnly.HoldsPublish("anyone") {
		t.Error("allowed signers with no roles grant publish to everyone")
	}
}

func TestCoversAnswersEveryPairOfTheSharedAudiencesTableAsTheKernelDoes(t *testing.T) {
	var shared struct {
		Text  string `json:"text"`
		Pairs []struct {
			Granted string `json:"granted"`
			Target  string `json:"target"`
			Covers  bool   `json:"covers"`
		} `json:"pairs"`
	}
	data, _ := os.ReadFile(conformance + "/audiences.json")
	if err := json.Unmarshal(data, &shared); err != nil {
		t.Fatal(err)
	}
	audiences, err := release.ParseAudiences(shared.Text)
	if err != nil {
		t.Fatal(err)
	}
	if len(shared.Pairs) < 50 {
		t.Fatalf("%d pairs, want at least 50", len(shared.Pairs))
	}
	for _, pair := range shared.Pairs {
		if got := audiences.Covers(pair.Granted, pair.Target); got != pair.Covers {
			t.Errorf("%s covers %s: %v, want %v", pair.Granted, pair.Target, got, pair.Covers)
		}
	}
}

func TestRefusesACycleOfIncludesAndAnIncludeOfAnUndeclaredName(t *testing.T) {
	for _, text := range []string{"a includes b\nb includes a\n", "a includes nobody\n", "a member public\n"} {
		if _, err := release.ParseAudiences(text); err == nil {
			t.Errorf("%q parsed", text)
		}
	}
}

func TestARevocationWithdrawsExactlyTheReleasesItSupersedes(t *testing.T) {
	roles, _ := release.ParseRoles("p owner any\n", false)
	released := func(id string) release.Attestation {
		return release.Attestation{ID: id, Subject: "s", Principal: "p", Purpose: "released", Audience: "public", Extent: "record", Signed: true}
	}
	revocation := release.Attestation{ID: "v", Subject: "s", Principal: "p", Purpose: "revoked", Supersedes: []string{"r1"}, Signed: true}
	elsewhere := release.Attestation{ID: "w", Subject: "other", Principal: "p", Purpose: "revoked", Supersedes: []string{"r2"}, Signed: true}
	unsigned := release.Attestation{ID: "u", Subject: "s", Principal: "p", Purpose: "revoked", Supersedes: []string{"r2"}}

	standing := release.Standing([]release.Attestation{released("r1"), released("r2"), revocation, elsewhere, unsigned}, roles)

	var ids []string
	for _, a := range standing {
		ids = append(ids, a.ID)
	}
	if !slices.Equal(ids, []string{"r2"}) {
		t.Fatalf("standing %v, want [r2]", ids)
	}
}

func TestAReleaseRelayedThroughAModelNeverStands(t *testing.T) {
	roles, _ := release.ParseRoles("p owner any\n", false)
	signed := release.Attestation{ID: "r1", Subject: "s", Principal: "p", Via: "signature", Purpose: "released", Audience: "public", Extent: "record", Signed: true}
	relayed := release.Attestation{ID: "r2", Subject: "s", Principal: "p", Via: "model", Purpose: "released", Audience: "public", Extent: "record", Signed: true}

	standing := release.Standing([]release.Attestation{signed, relayed}, roles)

	if len(standing) != 1 || standing[0].ID != "r1" {
		t.Fatalf("standing %v, want only r1", standing)
	}
}
