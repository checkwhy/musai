package trace_test

import (
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/sig"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trace"
	"github.com/checkwhy/musai/verify/internal/trust"
)

const (
	claim       = "sha256:921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68"
	briefRun    = "sha256:946cb831732cdcf0a2fe465c7acb49e48fdb4015c92d7efc86ea930b4385e679"
	ruling      = "sha256:4c006fc58e70d4e7df0d10469cd874f7897a6920edeaf35140949b954c5f539f"
	attestation = "sha256:42eb14cc43763a1d89f80dd81def025b9bda99a2e7b4d0b128d06569ba365b28"
	caseID      = "sha256:8224a39f5eda0207790d1350440b36895c54872d3bf1a6f84de89de72976e4f3"
)

func load(t *testing.T, dir string) (*check.Index, refs.Table, check.Result) {
	t.Helper()
	src, err := source.Open("../../../conformance/"+dir, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	table, err := refs.Load()
	if err != nil {
		t.Fatal(err)
	}
	tree, err := check.Load(src.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	index, _ := check.Records(tree, table)
	result, err := check.Run(src, table, trust.Own(src))
	if err != nil {
		t.Fatal(err)
	}
	return index, table, result
}

// ownSigners are the keys a conformance source's own allowed-signers trusts.
func ownSigners(t *testing.T, dir string) []sig.Signer {
	t.Helper()
	src, err := source.Open("../../../conformance/"+dir, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return trust.Own(src).Signers()
}

func find(node *trace.Node, id string) *trace.Node {
	if node == nil {
		return nil
	}
	if node.ID == id {
		return node
	}
	for _, edge := range node.Edges {
		if found := find(edge.Node, id); found != nil && !edge.Seen {
			return found
		}
	}
	return nil
}

func TestAClaimReachesTheRulingOverItItsBriefAndTheAttestationBehindIt(t *testing.T) {
	index, table, result := load(t, "bundles/passing")
	root, err := trace.Walk(index, table, claim, trace.SignatureStates(result), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{ruling, briefRun, attestation} {
		if find(root, id) == nil {
			t.Errorf("the walk from the claim does not reach %s", id)
		}
	}
	text := root.Text()
	for _, want := range []string{"holds", "made by florin", "signature verified", "brief"} {
		if !strings.Contains(text, want) {
			t.Errorf("the trace does not say %q:\n%s", want, text)
		}
	}
	for _, word := range []string{"why", "status", "derived"} {
		if strings.Contains(strings.ToLower(text), word) {
			t.Errorf("the trace uses the word %q:\n%s", word, text)
		}
	}
}

func TestARunAtSchemaVersionOneSaysItsPerformerWasNotRecorded(t *testing.T) {
	index, table, result := load(t, "bundles/passing")
	root, err := trace.Walk(index, table, briefRun, trace.SignatureStates(result), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(root.Summary, "performer not recorded") || !strings.Contains(root.Summary, "determinism not recorded") {
		t.Fatalf("summary %q", root.Summary)
	}
}

func TestACaseReachesItsClaims(t *testing.T) {
	index, table, result := load(t, "bundles/passing")
	root, err := trace.Walk(index, table, caseID, trace.SignatureStates(result), nil)
	if err != nil {
		t.Fatal(err)
	}
	if find(root, claim) == nil {
		t.Fatalf("the case does not reach its claim:\n%s", root.Text())
	}
}

func TestATargetTheSourceDoesNotHoldIsShownAsAbsent(t *testing.T) {
	index, table, result := load(t, "bundles/dangling-reference")
	root, err := trace.Walk(index, table, ruling, trace.SignatureStates(result), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(root.Text(), "not in the source") {
		t.Fatalf("an absent brief is not shown as absent:\n%s", root.Text())
	}
}

func TestASealOverTheRulingIsReachedAndSaysTheAudienceItIsSealedFromItsSignerAndItsSignature(t *testing.T) {
	index, table, result := load(t, "releases/sealed")
	root, err := trace.Walk(index, table, ruling, trace.SignatureStates(result), ownSigners(t, "releases/sealed"))
	if err != nil {
		t.Fatal(err)
	}
	text := root.Text()
	if !regexp.MustCompile(`sealed from peer by florin \(key:SHA256:[A-Za-z0-9+/]{43}\) via signature · signature verified`).MatchString(text) {
		t.Fatalf("the trace does not show the seal over the ruling:\n%s", text)
	}
}

func TestASealNamingItsClosureSaysSo(t *testing.T) {
	index, table, result := load(t, "releases/sealed-closure")
	root, err := trace.Walk(index, table, ruling, trace.SignatureStates(result), ownSigners(t, "releases/sealed-closure"))
	if err != nil {
		t.Fatal(err)
	}
	text := root.Text()
	if !regexp.MustCompile(`sealed from peer by florin \(key:SHA256:[A-Za-z0-9+/]{43}\) via signature · extent closure · signature verified`).MatchString(text) {
		t.Fatalf("the trace does not show the seal's extent:\n%s", text)
	}
}

func TestResolveTakesAUniquePrefix(t *testing.T) {
	index, _, _ := load(t, "bundles/passing")
	for _, given := range []string{claim, "921e892d", "sha256:921e892d"} {
		if id, err := trace.Resolve(index, given); err != nil || id != claim {
			t.Errorf("Resolve(%q) = %s, %v", given, id, err)
		}
	}
	if _, err := trace.Resolve(index, "ffffffff"); !errors.Is(err, trace.ErrNoSuchRecord) {
		t.Errorf("an unknown prefix: %v", err)
	}
	if _, err := trace.Resolve(index, "92"); !errors.Is(err, trace.ErrPrefixTooShort) {
		t.Errorf("a short prefix: %v", err)
	}
}

func TestRecipePrintsAComputedRunAsItsCommandAndSubstratesAlone(t *testing.T) {
	index, _, _ := load(t, "bundles/passing")
	recipe, err := trace.RecipeOf(index, briefRun)
	if err != nil {
		t.Fatal(err)
	}
	text := recipe.Text()
	for _, want := range []string{"scope-head", "gitCommit 6ea7e9a29f850873086f2eaebd3bed913bf75a27", "brief sha256:921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68"} {
		if !strings.Contains(text, want) {
			t.Errorf("the recipe does not say %q:\n%s", want, text)
		}
	}
	for _, absent := range []string{"isolation", "working directory", "environment", "declared"} {
		if strings.Contains(text, absent) {
			t.Errorf("a computed run's recipe names %q:\n%s", absent, text)
		}
	}
	if _, err := trace.RecipeOf(index, claim); !errors.Is(err, trace.ErrNotARun) {
		t.Errorf("a claim's recipe: %v", err)
	}
}

func TestRecipePrintsWhatAReceiverNeedsToRerunACommandRun(t *testing.T) {
	const id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	index := &check.Index{Records: map[string]*check.Record{id: {ID: id, Kind: "run", Value: map[string]any{
		"runKind": "run",
		"recipe": map[string]any{
			"command": []any{"pnpm", "test"}, "workingDirectory": "./project", "isolation": "hygiene",
			"environment": map[string]any{"CI": "1"}, "declared": []any{map[string]any{"name": "TOKEN", "secret": true}},
			"substrates": []any{map[string]any{"name": "project", "digest": map[string]any{"gitTree": "abc"}}},
		},
	}}}}
	recipe, err := trace.RecipeOf(index, id)
	if err != nil {
		t.Fatal(err)
	}
	text := recipe.Text()
	for _, want := range []string{"isolation          hygiene", "working directory  ./project", "CI=1", "TOKEN (secret)", "pnpm test"} {
		if !strings.Contains(text, want) {
			t.Errorf("the recipe does not say %q:\n%s", want, text)
		}
	}
}

func TestShellQuoteQuotesOnlyWhatAShellWouldSplitOrExpand(t *testing.T) {
	got := trace.ShellQuote([]string{"musai", "a b", "it's", "$HOME", "plain-arg_1.0", ""})
	want := `musai 'a b' 'it'\''s' '$HOME' plain-arg_1.0 ''`
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
