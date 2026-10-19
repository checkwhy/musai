package conformance_test

import (
	"io/fs"
	"os"
	"testing"
	"testing/fstest"

	"github.com/checkwhy/musai/verify/internal/conformance"
)

func TestTheRepositorysCorpusPassesEveryCase(t *testing.T) {
	cases, err := conformance.Run(os.DirFS("../../../conformance"))
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20+1+1+16 {
		t.Fatalf("%d cases, want at least 38", len(cases))
	}
	for _, c := range cases {
		if !c.Passed {
			t.Errorf("%s %s: %s", c.Suite, c.Name, c.Detail)
		}
	}
}

func TestACorpusDisagreeingWithTheVerifierFailsTheCase(t *testing.T) {
	corpus := fstest.MapFS{
		"canonical.json":    &fstest.MapFile{Data: []byte(`[{"name":"wrong","input":{"b":1,"a":2},"canonical":"{\"b\":1,\"a\":2}","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]`)},
		"differential.json": &fstest.MapFile{Data: []byte(`{"cases":[{"text":"[1.0]","canonical":"[1.0]","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}`)},
		"frozen.json":       &fstest.MapFile{Data: []byte(`{"cases":[{"name":"wrong","kind":"rule","record":{"b":1,"a":2},"canonical":"{\"b\":1,\"a\":2}","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}`)},
		"references.json":   &fstest.MapFile{Data: []byte(`{}`)},
		"bundles.json":      &fstest.MapFile{Data: []byte(`[]`)},
		"digests.json":      &fstest.MapFile{Data: []byte(`{}`)},
		"exports.json":      &fstest.MapFile{Data: []byte(`[]`)},
	}
	cases, err := conformance.Run(corpus)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if c.Passed {
			t.Errorf("%s %s passed against a corpus it disagrees with", c.Suite, c.Name)
		}
	}
	if len(cases) != 4 {
		t.Fatalf("%d cases, want 4", len(cases))
	}
}

func TestABundleDigestingOtherwiseThanTheCorpusNamesFailsItsCase(t *testing.T) {
	corpus := fstest.MapFS{
		"canonical.json":    &fstest.MapFile{Data: []byte(`[]`)},
		"differential.json": &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"frozen.json":       &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"references.json":   &fstest.MapFile{Data: []byte(`{}`)},
		"bundles.json":      &fstest.MapFile{Data: []byte(`[{"name":"passing","verdict":"verified","codes":["ref.pin-absent"]}]`)},
		"digests.json":      &fstest.MapFile{Data: []byte(`{"passing":"0000000000000000000000000000000000000000000000000000000000000000"}`)},
		"exports.json":      &fstest.MapFile{Data: []byte(`[]`)},
	}
	passing := os.DirFS("../../../conformance/bundles/passing")
	err := fs.WalkDir(passing, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(passing, path)
		corpus["bundles/passing/"+path] = &fstest.MapFile{Data: data}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	cases, err := conformance.Run(corpus)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if c.Suite == "bundles" && c.Passed {
			t.Errorf("%s passed with a digest the corpus does not name", c.Name)
		}
	}
}
