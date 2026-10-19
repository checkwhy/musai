package canon_test

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/canon"
)

const conformance = "../../../conformance"

func readJSON(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(conformance, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func TestEveryCanonicalVectorHashesToItsRecordedID(t *testing.T) {
	var rows []struct {
		Name      string         `json:"name"`
		Input     jsontext.Value `json:"input"`
		Canonical string         `json:"canonical"`
		ID        string         `json:"id"`
	}
	readJSON(t, "canonical.json", &rows)
	if len(rows) < 20 {
		t.Fatalf("read %d vectors, want at least 20", len(rows))
	}
	for _, row := range rows {
		id, canonical, err := canon.RecordID(row.Input)
		if err != nil {
			t.Errorf("%s: %v", row.Name, err)
			continue
		}
		if string(canonical) != row.Canonical {
			t.Errorf("%s: canonical %s, want %s", row.Name, canonical, row.Canonical)
		}
		if id != row.ID {
			t.Errorf("%s: id %s, want %s", row.Name, id, row.ID)
		}
	}
}

func TestEveryDifferentialValueCanonicalisesToTheKernelsBytes(t *testing.T) {
	var corpus struct {
		Cases []struct {
			Text      string `json:"text"`
			Canonical string `json:"canonical"`
			ID        string `json:"id"`
		} `json:"cases"`
	}
	readJSON(t, "differential.json", &corpus)
	if len(corpus.Cases) < 2000 {
		t.Fatalf("read %d cases, want at least 2000", len(corpus.Cases))
	}
	failed := 0
	for i, entry := range corpus.Cases {
		id, canonical, err := canon.RecordID([]byte(entry.Text))
		if err != nil || string(canonical) != entry.Canonical || id != entry.ID {
			failed++
			if failed <= 5 {
				t.Errorf("case %d: err %v\n got  %s\n want %s", i, err, canonical, entry.Canonical)
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d differential cases disagree with the kernel", failed, len(corpus.Cases))
	}
}

func TestRefusesADuplicateKey(t *testing.T) {
	if _, _, err := canon.RecordID([]byte(`{"a":1,"a":2}`)); err == nil {
		t.Fatal("a duplicate key canonicalised")
	}
}

func TestRefusesInvalidUTF8(t *testing.T) {
	if _, _, err := canon.RecordID([]byte("{\"a\":\"\xff\"}")); err == nil {
		t.Fatal("invalid UTF-8 canonicalised")
	}
}

func TestRefusesALoneSurrogate(t *testing.T) {
	if _, _, err := canon.RecordID([]byte(`{"a":"\ud800"}`)); err == nil {
		t.Fatal("a lone surrogate canonicalised")
	}
}

func TestABlobIDIsTheDigestOfTheRawBytes(t *testing.T) {
	const empty = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := canon.BlobID(nil); got != empty {
		t.Fatalf("BlobID(nil) = %s, want %s", got, empty)
	}
}

func TestIsIDAcceptsOnlyTheOneSpelling(t *testing.T) {
	good := "sha256:" + strings.Repeat("a", 64)
	for _, s := range []string{good} {
		if !canon.IsID(s) {
			t.Errorf("IsID(%q) = false", s)
		}
	}
	for _, s := range []string{"", "sha256:" + strings.Repeat("A", 64), "sha256:" + strings.Repeat("a", 63), " " + good, good + "\n", "sha512:" + strings.Repeat("a", 64)} {
		if canon.IsID(s) {
			t.Errorf("IsID(%q) = true", s)
		}
	}
	if canon.Hex(good) != strings.Repeat("a", 64) {
		t.Error("Hex does not strip the algorithm")
	}
}
