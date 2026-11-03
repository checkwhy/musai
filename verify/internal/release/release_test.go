package release_test

import (
	"bytes"
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

func TestPublishIsHeldOnlyAtScopeAnyOnceTheTrustBranchNamesASigner(t *testing.T) {
	scoped, _ := release.ParseRoles("p owner case-1\n", false)
	if scoped.HoldsPublish("p") {
		t.Error("an owner at a narrower scope than any holds publish")
	}
	signersOnly, _ := release.ParseRoles("", false)
	if signersOnly.HoldsPublish("anyone") {
		t.Error("allowed signers with no roles grant publish to everyone")
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

	standing := release.Standing([]release.Attestation{released("r1"), released("r2"), revocation, elsewhere}, roles)

	var ids []string
	for _, a := range standing {
		ids = append(ids, a.ID)
	}
	if !slices.Equal(ids, []string{"r2"}) {
		t.Fatalf("standing %v, want [r2]", ids)
	}
}

func TestAnUnverifiedRevocationWithdrawsOnlyInTheNameOfAPublishHolderOrTheReleasesWriter(t *testing.T) {
	roles, _ := release.ParseRoles("p owner any\n", false)
	released := release.Attestation{ID: "r", Subject: "s", Principal: "p", Purpose: "released", Audience: "public", Extent: "record", Signed: true}
	stranger := release.Attestation{ID: "x", Subject: "s", Principal: "q", Purpose: "revoked", Supersedes: []string{"r"}}
	if standing := release.Standing([]release.Attestation{released, stranger}, roles); len(standing) != 1 {
		t.Fatalf("a stranger's unsigned revocation left %v standing, want [r]", standing)
	}
	stripped := release.Attestation{ID: "u", Subject: "s", Principal: "p", Purpose: "revoked", Supersedes: []string{"r"}}
	if standing := release.Standing([]release.Attestation{released, stripped}, roles); len(standing) != 0 {
		t.Fatalf("a stripped revocation in a publish holder's name left %v standing, want none", standing)
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

func TestAReleaseOfAnUnknownVersionCoversNothingYetWithdrawsWhatItSupersedes(t *testing.T) {
	roles, _ := release.ParseRoles("p owner any\n", false)
	earlier := release.Attestation{ID: "r1", Subject: "s", Principal: "p", Via: "signature", Purpose: "released", Audience: "public", Extent: "record", Signed: true}
	later := release.Attestation{ID: "r2", Subject: "s", Principal: "p", Via: "signature", Purpose: "released", Audience: "public", Extent: "record", Supersedes: []string{"r1"}, Signed: true, Unknown: true}

	if standing := release.Standing([]release.Attestation{earlier, later}, roles); len(standing) != 0 {
		t.Fatalf("standing %v, want none", standing)
	}
}
