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
	if want := 20 + 1 + 1 + 6 + 1 + 16 + 7 + 90 + 10 + 8; len(cases) < want {
		t.Fatalf("%d cases, want at least %d", len(cases), want)
	}
	for _, c := range cases {
		if !c.Passed {
			t.Errorf("%s %s: %s", c.Suite, c.Name, c.Detail)
		}
	}
}

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5"

func TestACorpusDisagreeingWithTheVerifierFailsTheCase(t *testing.T) {
	corpus := fstest.MapFS{
		"canonical.json":    &fstest.MapFile{Data: []byte(`[{"name":"wrong","input":{"b":1,"a":2},"canonical":"{\"b\":1,\"a\":2}","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]`)},
		"differential.json": &fstest.MapFile{Data: []byte(`{"cases":[{"text":"[1.0]","canonical":"[1.0]","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}`)},
		"frozen.json":       &fstest.MapFile{Data: []byte(`{"cases":[{"name":"wrong","kind":"rule","record":{"b":1,"a":2},"canonical":"{\"b\":1,\"a\":2}","id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}`)},
		"references.json":   &fstest.MapFile{Data: []byte(`{}`)},
		"roles.json":        &fstest.MapFile{Data: []byte(`{"roles":{"owner":[]},"emptyDefault":[]}`)},
		"audiences.json":    &fstest.MapFile{Data: []byte(`{"text":"","pairs":[{"granted":"public","target":"public","covers":false}]}`)},
		"allowed-signers.json": &fstest.MapFile{Data: []byte(`{"cases":[
			{"name":"refused as accepted","line":"florin bogus ` + key + `","outcome":"accepted","principals":["florin"],"certAuthority":false},
			{"name":"refused for another reason","line":"florin bogus ` + key + `","outcome":"refused","reason":"option-unquoted"},
			{"name":"read with other principals","line":"florin ` + key + `","outcome":"accepted","principals":["alice"],"certAuthority":false},
			{"name":"read with other namespaces","line":"florin namespaces=\"git\" ` + key + `","outcome":"accepted","principals":["florin"],"certAuthority":false,"namespaces":"musai"},
			{"name":"read as no cert-authority","line":"florin cert-authority ` + key + `","outcome":"accepted","principals":["florin"],"certAuthority":false},
			{"name":"read with another window","line":"florin valid-after=\"20250101Z\" ` + key + `","outcome":"accepted","principals":["florin"],"certAuthority":false,"validAfter":1},
			{"name":"read as unbounded","line":"florin valid-before=\"20250101Z\" ` + key + `","outcome":"accepted","principals":["florin"],"certAuthority":false,"validAfter":null,"validBefore":null},
			{"name":"accepted as refused","line":"florin ` + key + `","outcome":"refused","reason":"incomplete"}
		]}`)},
		"bundles.json":  &fstest.MapFile{Data: []byte(`[]`)},
		"releases.json": &fstest.MapFile{Data: []byte(`[]`)},
		"digests.json":  &fstest.MapFile{Data: []byte(`{}`)},
		"exports.json":  &fstest.MapFile{Data: []byte(`[]`)},
		"recipes.json": &fstest.MapFile{Data: []byte(`{"cases":[
			{"name":"an engine line with a container name","engine":["docker","run","--rm","--name","musai-run-1"],"record":{"kind":"run","recipe":{"command":["true"],"workingDirectory":".","substrates":[{"uri":"example/image","mediaType":"application/vnd.oci.image.manifest.v1+json"}]},"observation":{"isolationHeld":"container","resolved":[{"uri":"example/image","digest":{"sha256":"ab"}}]}}},
			{"name":"no engine line for a container run","engine":null,"record":{"kind":"run","recipe":{"command":["true"],"workingDirectory":".","substrates":[{"uri":"example/image","mediaType":"application/vnd.oci.image.manifest.v1+json"}]},"observation":{"isolationHeld":"container","resolved":[{"uri":"example/image","digest":{"sha256":"ab"}}]}}},
			{"name":"an engine line quoted another way","engine":["docker","run","--rm","--network","none","-v","/srv:/musai/tree:ro","-v","$(mktemp -d):/musai/scratch:rw","--tmpfs","/musai/private/home:exec,mode=1777","--tmpfs","/musai/private/tmp:exec,mode=1777","--tmpfs","/musai/private/xdg-config:exec,mode=1777","--tmpfs","/musai/private/xdg-cache:exec,mode=1777","--tmpfs","/musai/private/xdg-data:exec,mode=1777","--tmpfs","/musai/private/xdg-state:exec,mode=1777","-w","/musai/tree","-e","HOME=/musai/private/home","-e","TMPDIR=/musai/private/tmp","-e","TEMP=/musai/private/tmp","-e","TMP=/musai/private/tmp","-e","XDG_CONFIG_HOME=/musai/private/xdg-config","-e","XDG_CACHE_HOME=/musai/private/xdg-cache","-e","XDG_DATA_HOME=/musai/private/xdg-data","-e","XDG_STATE_HOME=/musai/private/xdg-state","-e","SSH_AUTH_SOCK=","-e","GIT_CONFIG_NOSYSTEM=1","-e","GIT_CONFIG_GLOBAL=/musai/scratch/unwritten-global-config","--entrypoint","echo","example/image@sha256:ab","$HOME"],"shell":"echo '$HOME'","engineShell":"docker run --rm --network none -v /srv:/musai/tree:ro -v \"$(mktemp -d)\":/musai/scratch:rw --entrypoint echo example/image@sha256:ab \"$HOME\"","record":{"kind":"run","recipe":{"command":["echo","$HOME"],"workingDirectory":"/srv","substrates":[{"uri":"example/image","mediaType":"application/vnd.oci.image.manifest.v1+json"}]},"observation":{"isolationHeld":"container","resolved":[{"uri":"example/image","digest":{"sha256":"ab"}}]}}}
		]}`)},
		"printable.json": &fstest.MapFile{Data: []byte(`{"cases":[
			{"name":"an escape sequence printed raw","text":"a\u001bb","printed":"a\u001bb"}
		]}`)},
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
	if len(cases) != 20 {
		t.Fatalf("%d cases, want 20", len(cases))
	}
}

func TestABundleDigestingOtherwiseThanTheCorpusNamesFailsItsCase(t *testing.T) {
	corpus := fstest.MapFS{
		"canonical.json":       &fstest.MapFile{Data: []byte(`[]`)},
		"differential.json":    &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"frozen.json":          &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"references.json":      &fstest.MapFile{Data: []byte(`{}`)},
		"roles.json":           &fstest.MapFile{Data: []byte(`{"roles":{},"emptyDefault":[]}`)},
		"audiences.json":       &fstest.MapFile{Data: []byte(`{"text":"","pairs":[]}`)},
		"allowed-signers.json": &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"bundles.json":         &fstest.MapFile{Data: []byte(`[{"name":"passing","verdict":"verified","codes":["ref.pin-absent"]}]`)},
		"releases.json":        &fstest.MapFile{Data: []byte(`[]`)},
		"digests.json":         &fstest.MapFile{Data: []byte(`{"passing":"0000000000000000000000000000000000000000000000000000000000000000"}`)},
		"exports.json":         &fstest.MapFile{Data: []byte(`[]`)},
		"recipes.json":         &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
		"printable.json":       &fstest.MapFile{Data: []byte(`{"cases":[]}`)},
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
