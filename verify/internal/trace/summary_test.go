package trace

import (
	"testing"

	"github.com/checkwhy/musai/verify/internal/check"
)

func checkClaim(conditions map[string]any) *check.Record {
	return &check.Record{Kind: "claim", Value: map[string]any{
		"type":       "musai.core/check@1",
		"rendering":  "tests pass",
		"conditions": conditions,
	}}
}

func TestACheckClaimSaysTheCommandItsDeclaredRecipeRuns(t *testing.T) {
	declared := `{"expectations":[],"recipes":[{"kind":"run","name":"check","recipe":{"command":["node","--test","a b"]}}]}`
	got := summary(checkClaim(map[string]any{declarativeRule: declared}), nil, nil)
	if want := "musai.core/check@1 · tests pass · runs node --test 'a b'"; got != want {
		t.Fatalf("summary %q, want %q", got, want)
	}
}

func TestAClaimAnotherRuleJudgesSaysNoCommand(t *testing.T) {
	got := summary(checkClaim(map[string]any{"example/rule": `{"reads":[]}`}), nil, nil)
	if want := "musai.core/check@1 · tests pass"; got != want {
		t.Fatalf("summary %q, want %q", got, want)
	}
}
