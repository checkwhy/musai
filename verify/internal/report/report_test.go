package report_test

import (
	"bytes"
	"encoding/json/v2"
	"flag"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/report"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

var update = flag.Bool("update", false, "rewrite the golden draft")

const golden = "testdata/draft.json"

func draftOf(t *testing.T, in report.Input) report.RunDraft {
	t.Helper()
	draft, err := report.Draft(in)
	if err != nil {
		t.Fatal(err)
	}
	return draft
}

func passingInput(t *testing.T) report.Input {
	t.Helper()
	src, err := source.Open("../../../conformance/bundles/passing", source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	table, err := refs.Load()
	if err != nil {
		t.Fatal(err)
	}
	result, err := check.Run(src, table, trust.Own(src))
	if err != nil {
		t.Fatal(err)
	}
	digest, err := source.Digest(src.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	return report.Input{
		Result:       result,
		BundleDigest: digest,
		Principal:    "receiver",
		Version:      "v0.1.0",
		Binary:       canon.BlobID([]byte("a verifier binary")),
	}
}

func TestTheDraftOfThePassingBundleIsTheGolden(t *testing.T) {
	draft, err := report.Canonical(draftOf(t, passingInput(t)))
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile(golden, draft, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(draft, want) {
		t.Fatalf("draft differs from %s (run with -update after checking why):\n%s", golden, draft)
	}
}

func TestTheDraftCarriesExactlyTheKernelsRunFieldsWithoutAVersion(t *testing.T) {
	draft, err := report.Canonical(draftOf(t, passingInput(t)))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(draft, &fields); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for key := range fields {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	want := []string{"determinism", "kind", "observation", "performer", "recipe", "runKind", "supersedes"}
	if !slices.Equal(keys, want) {
		t.Fatalf("keys %v, want %v", keys, want)
	}
	performer := fields["performer"].(map[string]any)
	if performer["kind"] != "foreign" || performer["tool"] != "musai-verify" || performer["principal"] != "receiver" {
		t.Fatalf("performer %v", performer)
	}
}

func TestTheOutputIsTheCanonicalFindingsAndTheExitCodeTheVerdict(t *testing.T) {
	input := passingInput(t)
	draft := draftOf(t, input)
	canonical, err := canon.Canonical([]byte(draft.Observation.Output))
	if err != nil || !bytes.Equal(canonical, []byte(draft.Observation.Output)) {
		t.Fatalf("the output is not canonical JSON: %v", err)
	}
	var findings []check.Finding
	if err := json.Unmarshal([]byte(draft.Observation.Output), &findings); err != nil {
		t.Fatal(err)
	}
	if len(findings) != len(input.Result.Findings) {
		t.Fatalf("%d findings in the output, %d in the result", len(findings), len(input.Result.Findings))
	}
	if draft.Observation.ExitCode != report.Verified {
		t.Fatalf("exit code %d for a verified bundle", draft.Observation.ExitCode)
	}
	input.Result.Findings = append(input.Result.Findings, check.Finding{Code: "ref.dangling", Severity: check.Error})
	if code := report.ExitCode(input.Result); code != report.Failed {
		t.Fatalf("exit code %d for a failed verification", code)
	}
}

func TestAnIndependentTrustSourceIsASubstrateAndAnArgument(t *testing.T) {
	input := passingInput(t)
	input.Trust = trust.Set{{
		Argument:  "0123456789abcdef0123456789abcdef01234567",
		Substrate: &trust.Substrate{Name: "trust", Digest: map[string]string{"gitCommit": "0123456789abcdef0123456789abcdef01234567"}},
	}}
	draft := draftOf(t, input)
	if !slices.Contains(draft.Recipe.Command, "0123456789abcdef0123456789abcdef01234567") {
		t.Fatalf("command %v names no trust commit", draft.Recipe.Command)
	}
	if !slices.ContainsFunc(draft.Recipe.Substrates, func(d report.Descriptor) bool { return d.Name == "trust" && d.Digest["gitCommit"] != "" }) {
		t.Fatalf("substrates %+v name no trust commit", draft.Recipe.Substrates)
	}
}

func TestTheSourcesOwnTrustEntersNeitherTheCommandNorTheSubstrates(t *testing.T) {
	input := passingInput(t)
	src, err := source.Open("../../../conformance/bundles/passing", source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	input.Trust = trust.Own(src)
	draft := draftOf(t, input)
	if len(draft.Recipe.Command) != 3 || len(draft.Recipe.Substrates) != 2 {
		t.Fatalf("command %v, substrates %+v", draft.Recipe.Command, draft.Recipe.Substrates)
	}
}

func TestABinaryIsNamedByItsDigestInBareHexAsTheKernelsRunnerNamesIt(t *testing.T) {
	draft := draftOf(t, passingInput(t))
	if len(draft.Observation.Binaries) != 1 {
		t.Fatalf("binaries %+v", draft.Observation.Binaries)
	}
	if digest := draft.Observation.Binaries[0].Digest; len(digest) != 64 || strings.Trim(digest, "0123456789abcdef") != "" {
		t.Fatalf("digest %q is not 64 lowercase hex", digest)
	}
}

func TestTheRecipeNamesTheBundleBySubstrateSoNothingInItCanStandForTrust(t *testing.T) {
	draft := draftOf(t, passingInput(t))
	if !slices.Equal(draft.Recipe.Command, []string{"musai-verify", "verify", "bundle"}) {
		t.Fatalf("command %v", draft.Recipe.Command)
	}
}

func TestADeterministicDraftCarriesNoInstantSoItsIdIsItsContent(t *testing.T) {
	draft, err := report.Canonical(draftOf(t, passingInput(t)))
	if err != nil {
		t.Fatal(err)
	}
	var fields struct {
		Determinism string         `json:"determinism"`
		Observation map[string]any `json:"observation"`
	}
	if err := json.Unmarshal(draft, &fields); err != nil {
		t.Fatal(err)
	}
	if fields.Determinism != "deterministic" {
		t.Fatalf("determinism %q, want deterministic", fields.Determinism)
	}
	for _, instant := range []string{"startedAt", "finishedAt"} {
		if _, ok := fields.Observation[instant]; ok {
			t.Fatalf("the observation carries %s", instant)
		}
	}
}
