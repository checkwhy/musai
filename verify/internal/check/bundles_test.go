package check_test

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

const conformance = "../../../conformance"

func table(t *testing.T) refs.Table {
	t.Helper()
	loaded, err := refs.Load()
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

// codes returns the sorted, distinct error and warning codes of a result.
func codes(result check.Result) []string {
	var out []string
	for _, finding := range result.Findings {
		if finding.Severity != check.Info && !slices.Contains(out, finding.Code) {
			out = append(out, finding.Code)
		}
	}
	slices.Sort(out)
	return out
}

func TestEveryConformanceBundleProducesExactlyItsCodesAndVerdict(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(conformance, "bundles.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name    string   `json:"name"`
		Verdict string   `json:"verdict"`
		Codes   []string `json:"codes"`
	}
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 16 {
		t.Fatalf("%d bundle rows, want at least 16", len(rows))
	}
	for _, row := range rows {
		src, err := source.Open(filepath.Join(conformance, "bundles", row.Name), source.Options{})
		if err != nil {
			t.Fatalf("%s: %v", row.Name, err)
		}
		result, err := check.Run(src, table(t), trust.Own(src))
		if err != nil {
			t.Fatalf("%s: %v", row.Name, err)
		}
		if got := codes(result); !slices.Equal(got, row.Codes) {
			t.Errorf("%s: codes %v, want %v", row.Name, got, row.Codes)
			for _, f := range result.Findings {
				t.Logf("  %s %s %s %s: %s", f.Severity, f.Code, f.Path, f.At, f.Detail)
			}
		}
		verdict := "verified"
		if result.Failed() {
			verdict = "failed"
		}
		if verdict != row.Verdict {
			t.Errorf("%s: verdict %s, want %s", row.Name, verdict, row.Verdict)
		}
	}
}

func TestThePassingBundleReportsItsVerifiedSignature(t *testing.T) {
	src, err := source.Open(filepath.Join(conformance, "bundles", "passing"), source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	result, err := check.Run(src, table(t), trust.Own(src))
	if err != nil {
		t.Fatal(err)
	}
	if result.Records != 9 || result.Signatures != 1 {
		t.Fatalf("records %d, signatures %d; want 9 and 1", result.Records, result.Signatures)
	}
	if !slices.ContainsFunc(result.Findings, func(f check.Finding) bool { return f.Code == "sig.verified" }) {
		t.Fatal("no sig.verified finding")
	}
}

func TestEveryReleaseConformanceBundleProducesExactlyItsCodesAndVerdicts(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(conformance, "releases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name        string   `json:"name"`
		Verdict     string   `json:"verdict"`
		Entitlement string   `json:"entitlement"`
		Codes       []string `json:"codes"`
	}
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 7 {
		t.Fatalf("%d release rows, want at least 7", len(rows))
	}
	for _, row := range rows {
		src, err := source.Open(filepath.Join(conformance, "releases", row.Name), source.Options{})
		if err != nil {
			t.Fatalf("%s: %v", row.Name, err)
		}
		result, err := check.Run(src, table(t), trust.Own(src))
		if err != nil {
			t.Fatalf("%s: %v", row.Name, err)
		}
		if got := codes(result); !slices.Equal(got, row.Codes) {
			t.Errorf("%s: codes %v, want %v", row.Name, got, row.Codes)
			for _, f := range result.Findings {
				t.Logf("  %s %s %s %s: %s", f.Severity, f.Code, f.Path, f.At, f.Detail)
			}
		}
		if result.Failed() != (row.Verdict == "failed") {
			t.Errorf("%s: failed %v, want verdict %s", row.Name, result.Failed(), row.Verdict)
		}
		entitlement := "unchecked"
		if result.Released.Checked {
			entitlement = "uncovered"
			if result.Released.Covered == result.Released.Total {
				entitlement = "covered"
			}
		}
		if entitlement != row.Entitlement {
			t.Errorf("%s: entitlement %s (%d of %d), want %s", row.Name, entitlement, result.Released.Covered, result.Released.Total, row.Entitlement)
		}
	}
}
