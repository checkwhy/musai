package canon_test

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"

	"github.com/checkwhy/musai/verify/internal/canon"
)

// seedFromCorpus adds every canonical vector's input and the first
// differential texts to a fuzz corpus.
func seedFromCorpus(f *testing.F) {
	f.Helper()
	var rows []struct {
		Input jsontext.Value `json:"input"`
	}
	var differential struct {
		Cases []struct {
			Text string `json:"text"`
		} `json:"cases"`
	}
	for name, into := range map[string]any{"canonical.json": &rows, "differential.json": &differential} {
		data, err := os.ReadFile(filepath.Join(conformance, name))
		if err != nil {
			f.Fatal(err)
		}
		if err := json.Unmarshal(data, into); err != nil {
			f.Fatal(err)
		}
	}
	for _, row := range rows {
		f.Add([]byte(row.Input))
	}
	for _, entry := range differential.Cases[:200] {
		f.Add([]byte(entry.Text))
	}
}

func FuzzCanonicalIsIdempotentAndNeverPanics(f *testing.F) {
	seedFromCorpus(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		id, canonical, err := canon.RecordID(data)
		if err != nil {
			return
		}
		again, twice, err := canon.RecordID(canonical)
		if err != nil {
			t.Fatalf("canonical bytes %q do not canonicalise: %v", canonical, err)
		}
		if !bytes.Equal(canonical, twice) || id != again {
			t.Fatalf("canonicalising is not idempotent: %q then %q", canonical, twice)
		}
	})
}
