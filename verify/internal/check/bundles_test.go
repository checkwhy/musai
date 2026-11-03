package check_test

import (
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
