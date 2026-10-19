package check_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

func FuzzAnyBytesAtARecordPathYieldFindingsNeverAPanic(f *testing.F) {
	err := filepath.WalkDir(filepath.Join(conformance, "bundles"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return err
		}
		data, err := os.ReadFile(path)
		if err == nil {
			f.Add(data)
		}
		return err
	})
	if err != nil {
		f.Fatal(err)
	}
	loaded, err := refs.Load()
	if err != nil {
		f.Fatal(err)
	}
	const path = "records/claim/92/1e/921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68.json"
	f.Fuzz(func(t *testing.T, data []byte) {
		fsys := fstest.MapFS{path: &fstest.MapFile{Data: data}}
		src := &source.Source{Name: "fuzz", Bundle: fsys, Trust: fsys}
		result, err := check.Run(src, loaded, trust.Own(src))
		if err != nil {
			t.Fatalf("a record's bytes failed the run rather than yielding findings: %v", err)
		}
		if result.Records != 1 {
			t.Fatalf("read %d records", result.Records)
		}
	})
}
