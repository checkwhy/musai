package trace_test

import (
	"encoding/json/v2"
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
	result, err := check.Run(src, table, trust.Own(src))
	if err != nil {
		t.Fatal(err)
	}
	return result.Index, table, result
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

func TestATestimonysRecipeKeepsEachSubstratesMediaType(t *testing.T) {
	const id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	substrate := func(name, mediaType string) map[string]any {
		return map[string]any{"name": name, "digest": map[string]any{"sha256": "abc"}, "mediaType": mediaType}
	}
	index := &check.Index{Records: map[string]*check.Record{id: {ID: id, Kind: "run", Value: map[string]any{
		"runKind": "testimony",
		"recipe": map[string]any{"substrates": []any{
			substrate("brief", "application/vnd.musai.brief+json"),
			substrate("crew", "application/vnd.musai.crew+json"),
			substrate("model", "application/vnd.musai.model+json"),
		}},
	}}}}
	recipe, err := trace.RecipeOf(index, id)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(recipe)
	if err != nil {
		t.Fatal(err)
	}
	text := recipe.Text()
	for _, mediaType := range []string{"brief", "crew", "model"} {
		want := "application/vnd.musai." + mediaType + "+json"
		if !strings.Contains(text, want) {
			t.Errorf("the recipe does not say %q:\n%s", want, text)
		}
		if !strings.Contains(string(data), `"mediaType":"`+want+`"`) {
			t.Errorf("the recipe's JSON drops %q: %s", want, data)
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

func containerRun(command []any, held string, declared []any, bindings []any) *check.Index {
	const id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	image := map[string]any{"uri": "golang:1.25", "digest": map[string]any{}, "mediaType": "application/vnd.oci.image.manifest.v1+json"}
	resolved := map[string]any{"uri": "golang:1.25", "digest": map[string]any{"sha256": strings.Repeat("3f", 32)}, "mediaType": "application/vnd.oci.image.manifest.v1+json"}
	return &check.Index{Records: map[string]*check.Record{id: {ID: id, Kind: "run", Value: map[string]any{
		"runKind": "run",
		"recipe": map[string]any{
			"command": command, "workingDirectory": "pkg", "isolation": "container",
			"environment": map[string]any{"CI": "1"}, "declared": declared,
			"substrates": []any{map[string]any{"name": "tree", "uri": "musai:tree"}, image},
		},
		"observation": map[string]any{
			"resolved": []any{map[string]any{"name": "tree", "uri": "musai:tree", "digest": map[string]any{"gitTree": "abc"}}, resolved},
			"bindings": bindings, "isolationHeld": held,
		},
	}}}}
}

func TestAContainerRunsRecipePrintsTheEngineLineItsRunTookWithTheCheckoutAsAPlaceholderAndNoSecretValue(t *testing.T) {
	index := containerRun(
		[]any{"go", "test", "./..."}, "container",
		[]any{map[string]any{"name": "TOKEN", "secret": true}, map[string]any{"name": "REGION", "secret": false}},
		[]any{
			map[string]any{"name": "TOKEN", "secret": true, "value": nil, "keyedHash": "sha256:" + strings.Repeat("e1", 32), "keyId": "k1"},
			map[string]any{"name": "REGION", "secret": false, "value": "eu-west-1", "keyedHash": nil, "keyId": nil},
		},
	)
	recipe, err := trace.RecipeOf(index, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	want := `docker run --rm --network none -v "${MUSAI_CHECKOUT:?set it to your checkout}"/pkg:/musai/tree:ro -v "$(mktemp -d)":/musai/scratch:rw` +
		` --tmpfs '/musai/private/home:exec,mode=1777' --tmpfs '/musai/private/tmp:exec,mode=1777'` +
		` --tmpfs '/musai/private/xdg-config:exec,mode=1777' --tmpfs '/musai/private/xdg-cache:exec,mode=1777'` +
		` --tmpfs '/musai/private/xdg-data:exec,mode=1777' --tmpfs '/musai/private/xdg-state:exec,mode=1777'` +
		` -w /musai/tree -e 'HOME=/musai/private/home' -e 'TMPDIR=/musai/private/tmp' -e 'TEMP=/musai/private/tmp'` +
		` -e 'TMP=/musai/private/tmp' -e 'XDG_CONFIG_HOME=/musai/private/xdg-config' -e 'XDG_CACHE_HOME=/musai/private/xdg-cache'` +
		` -e 'XDG_DATA_HOME=/musai/private/xdg-data' -e 'XDG_STATE_HOME=/musai/private/xdg-state' -e 'SSH_AUTH_SOCK='` +
		` -e 'GIT_CONFIG_NOSYSTEM=1' -e 'GIT_CONFIG_GLOBAL=/musai/scratch/unwritten-global-config' -e 'CI=1' -e TOKEN -e REGION` +
		` --entrypoint go golang@sha256:` + strings.Repeat("3f", 32) + ` test ./...`
	text := recipe.Text()
	if !strings.Contains(text, "\n  "+want+"\n") {
		t.Errorf("the recipe does not print the engine line\n  %s\n%s", want, text)
	}
	if !strings.Contains(text, "MUSAI_CHECKOUT") || strings.Contains(text, "musai-run-") || strings.Contains(text, "--name") {
		t.Errorf("the recipe names the run's container or no checkout to set:\n%s", text)
	}
	if strings.Contains(text, "eu-west-1") || strings.Contains(text, strings.Repeat("e1", 32)) {
		t.Errorf("the recipe prints what a declared name was bound to:\n%s", text)
	}
}

func TestARunDeclaringNoImagePrintsNoEngineLine(t *testing.T) {
	const id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	index := &check.Index{Records: map[string]*check.Record{id: {ID: id, Kind: "run", Value: map[string]any{
		"runKind": "run",
		"recipe": map[string]any{
			"command": []any{"pnpm", "test"}, "workingDirectory": ".", "isolation": "hygiene",
			"substrates": []any{map[string]any{"name": "tree", "uri": "musai:tree"}},
		},
	}}}}
	recipe, err := trace.RecipeOf(index, id)
	if err != nil {
		t.Fatal(err)
	}
	if recipe.Engine != nil || strings.Contains(recipe.Text(), "engine line") {
		t.Errorf("a run outside a container prints an engine line:\n%s", recipe.Text())
	}
}

func TestAnImageRunHeldUnderHygienePrintsNoEngineLine(t *testing.T) {
	index := containerRun([]any{"go", "test", "./..."}, "hygiene", nil, nil)
	recipe, err := trace.RecipeOf(index, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if recipe.Engine != nil || strings.Contains(recipe.Text(), "engine line") {
		t.Errorf("a run that degraded to hygiene prints an engine line it never took:\n%s", recipe.Text())
	}
}

func TestAnEngineLineWhoseArgumentHoldsAControlCharacterWritesItAsADollarQuotedWord(t *testing.T) {
	recipe, err := trace.RecipeOf(containerRun([]any{"printf", "a\x1bb\n"}, "container", nil, nil), "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	text := recipe.Text()
	if !strings.HasSuffix(recipe.EngineShell, ` $'a\033b\n'`) || !strings.Contains(text, "\n  "+recipe.EngineShell+"\n") {
		t.Errorf("the engine line does not write the argument as one $'…' word:\n%s", text)
	}
	const shells = "run it in a shell reading $'…' (bash, zsh, ksh or a POSIX.1-2024 sh)"
	if !strings.Contains(text, "\ncommand            "+shells+"\n") || !strings.Contains(text, "; "+shells+"\n") {
		t.Errorf("a line holding a $'…' word does not name the shells that read it:\n%s", text)
	}
	plain, err := trace.RecipeOf(containerRun([]any{"go", "test"}, "container", nil, nil), "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain.Text(), "shell reading") {
		t.Errorf("a recipe holding no $'…' word names the shells that read one:\n%s", plain.Text())
	}
}

func TestALiteralPrintsAsTheAssignmentAShellReadsBackWhereItsNameIsOneAShellAssigns(t *testing.T) {
	const id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	index := containerRun([]any{"go", "test"}, "container", nil, nil)
	index.Records[id].Value["recipe"].(map[string]any)["environment"] = map[string]any{
		"CI": "1", "EMPTY": "", "A+B": "plus", "NOTE": "a b\nc",
	}
	recipe, err := trace.RecipeOf(index, id)
	if err != nil {
		t.Fatal(err)
	}
	text := recipe.Text()
	want := "environment        run it in a shell reading $'…' (bash, zsh, ksh or a POSIX.1-2024 sh)\n" +
		"  'A+B=plus'\n  CI=1\n  EMPTY=''\n  NOTE=$'a b\\nc'\n"
	if !strings.Contains(text, want) {
		t.Errorf("the environment does not print as assignments a shell reads back:\n%s", text)
	}
	if !strings.Contains(recipe.EngineShell, " -e 'CI=1' ") {
		t.Errorf("the engine line does not pass a literal as one quoted word:\n%s", recipe.EngineShell)
	}
}

func TestEveryWordAShellWouldReadAsOtherThanItselfIsQuoted(t *testing.T) {
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"A=b", "x", "--flag=a", "+%", "plain-arg_1.0"}, `'A=b' x '--flag=a' '+%' plain-arg_1.0`},
		{[]string{"it's \\ \u202e", "\xff", "\u0085"}, `$'it\'s \\ \342\200\256' $'\377' $'\302\205'`},
	} {
		if got := trace.ShellQuote(c.args); got != c.want {
			t.Errorf("ShellQuote(%q) = %s, want %s", c.args, got, c.want)
		}
	}
}

func TestOnlyTheMountsPlaceholdersAreLeftForTheShellNeverACommandsOwnArguments(t *testing.T) {
	command := []any{"grep", "-v", "$(mktemp -d)x", "-v", "${MUSAI_CHECKOUT:?set it to your checkout}y", "."}
	index := containerRun(command, "container", nil, nil)
	recipe, err := trace.RecipeOf(index, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if want := ` -v '$(mktemp -d)x' -v '${MUSAI_CHECKOUT:?set it to your checkout}y' .`; !strings.HasSuffix(recipe.EngineShell, want) {
		t.Errorf("the command's own arguments are left for the shell to expand:\n%s", recipe.EngineShell)
	}
	if !strings.Contains(recipe.EngineShell, ` -v "$(mktemp -d)":/musai/scratch:rw `) {
		t.Errorf("the scratch mount is not left for the shell:\n%s", recipe.EngineShell)
	}
}
