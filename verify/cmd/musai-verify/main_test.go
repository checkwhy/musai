package main

import (
	"archive/zip"
	"bytes"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rogpeppe/go-internal/testscript"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/trust"
	"github.com/checkwhy/musai/verify/internal/workspacetest"
)

func TestMain(m *testing.M) {
	testscript.Main(m, map[string]func(){
		"musai-verify": func() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) },
	})
}

func absolute(t *testing.T, path string) string {
	t.Helper()
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func TestScripts(t *testing.T) {
	conformance := absolute(t, "../../../conformance")
	var workspace string
	if _, err := exec.LookPath("git"); err == nil {
		workspace = t.TempDir()
		if err := workspacetest.Build(workspace); err != nil {
			t.Fatal(err)
		}
	}
	testscript.Run(t, testscript.Params{
		Dir: "testdata/script",
		Setup: func(env *testscript.Env) error {
			env.Setenv("CONFORMANCE", conformance)
			env.Setenv("WORKSPACE", workspace)
			return nil
		},
	})
}

func TestTheExitCodeSaysWhatToDoNext(t *testing.T) {
	bundles := absolute(t, "../../../conformance/bundles")
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"a bundle that verifies", []string{"verify", filepath.Join(bundles, "passing")}, 0},
		{"a bundle that fails", []string{"verify", filepath.Join(bundles, "flipped-byte")}, 3},
		{"a path holding no bundle", []string{"verify", t.TempDir()}, 2},
		{"an unknown flag", []string{"verify", "--nope"}, 2},
		{"an unknown command", []string{"frobnicate"}, 2},
		{"an id the source does not hold", []string{"trace", "--source", filepath.Join(bundles, "passing"), "ffffffff"}, 2},
		{"a recipe for a record that is no run", []string{"recipe", "--source", filepath.Join(bundles, "passing"), "921e892d"}, 2},
		{"help", []string{"--help"}, 0},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		if got := run(c.args, &out, &errOut); got != c.want {
			t.Errorf("%s: exit %d, want %d\nstdout: %s\nstderr: %s", c.name, got, c.want, out.String(), errOut.String())
		}
	}
}

// writeRecord stores a record at the path its id names under dir.
func writeRecord(t *testing.T, dir, kind, text string) string {
	t.Helper()
	id, canonical, err := canon.RecordID([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	hex := canon.Hex(id)
	path := filepath.Join(dir, "records", kind, hex[:2], hex[2:4], hex+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, canonical, 0o644); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRecordTextNeverReachesTheTerminalAsControlCharacters(t *testing.T) {
	dir := t.TempDir()
	forged := `\u001b[2K\r\u001b[32mverified: 9 records\u001b[8m\u202e`
	claim := writeRecord(t, dir, "claim", `{"about":[],"canonical":{},"conditions":{},"evidence":[],"exclusiveGroup":null,"kind":"claim","rendering":"`+forged+`","schemaVersion":3,"slot":"s","supersedes":[],"type":"t"}`)
	writeRecord(t, dir, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1","x`+forged+`":"`+claim+`"}`)
	for _, args := range [][]string{{"verify", dir}, {"trace", "--source", dir, claim}} {
		var out, errOut bytes.Buffer
		run(args, &out, &errOut)
		for _, forbidden := range []string{"\x1b", "\r", "\u202e"} {
			if strings.Contains(out.String()+errOut.String(), forbidden) {
				t.Errorf("%v printed %q:\n%s", args, forbidden, out.String())
			}
		}
	}
}

func TestAZipDamagedInTransitFailsVerificationRatherThanTheVerifier(t *testing.T) {
	root := absolute(t, "../../../conformance/bundles/passing")
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		f, err := w.CreateHeader(&zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Store})
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	for _, damaged := range []string{`"verdict":"holds"`, "florin ssh-ed25519"} {
		archive := bytes.Clone(buf.Bytes())
		at := bytes.Index(archive, []byte(damaged))
		if at < 0 {
			t.Fatalf("%q is not in the archive", damaged)
		}
		archive[at+1] ^= 0x20
		path := filepath.Join(t.TempDir(), "bundle.zip")
		if err := os.WriteFile(path, archive, 0o600); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"verify", path}, {"verify", "--json", path}} {
			var out, errOut bytes.Buffer
			if code := run(args, &out, &errOut); code != 3 || !strings.Contains(out.String(), "source.unreadable") {
				t.Errorf("damage at %q, %v: exit %d\nstdout: %s\nstderr: %s", damaged, args, code, out.String(), errOut.String())
			}
		}
	}
}

func TestAPanicIsTheVerifierFailingNotTheInvocation(t *testing.T) {
	var errOut bytes.Buffer
	code := func() (code int) {
		exited := -1
		defer recoverTo(&errOut, &exited, &code)
		panic("an index out of range")
	}()
	if code != 1 || !strings.Contains(errOut.String(), "the verifier failed: an index out of range") {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
}

func TestTheHTTPSFetchTellsAMissingPageFromAFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/florinutz.keys":
			fmt.Fprintln(w, "ssh-ed25519 AAAA")
		case "/broken.keys":
			http.Error(w, "down", http.StatusBadGateway)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	fetch := httpsFetch(server.Client())
	if body, err := fetch(server.URL + "/florinutz.keys"); err != nil || string(body) != "ssh-ed25519 AAAA\n" {
		t.Fatalf("body %q, err %v", body, err)
	}
	if _, err := fetch(server.URL + "/nobody.keys"); !errors.Is(err, trust.ErrNotFound) {
		t.Fatalf("a 404: err %v", err)
	}
	if _, err := fetch(server.URL + "/broken.keys"); err == nil || errors.Is(err, trust.ErrNotFound) {
		t.Fatalf("a 502: err %v", err)
	}
}

func TestAGitHubFetchFollowsNoRedirectOffHTTPSOrOffGitHub(t *testing.T) {
	check := githubClient().CheckRedirect
	for target, allowed := range map[string]bool{
		"https://github.com/florinutz.keys":       true,
		"http://github.com/florinutz.keys":        false,
		"https://keys.example.org/florinutz.keys": false,
		"https://github.com.example.org/x.keys":   false,
	} {
		request, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := check(request, nil) == nil; got != allowed {
			t.Errorf("%s: followed=%v, want %v", target, got, allowed)
		}
	}
}

func TestAFindingsOutputIsTheSameWhereverTheRecipeIsRerun(t *testing.T) {
	outputs := make([]string, 2)
	for i := range outputs {
		dir := filepath.Join(t.TempDir(), "keys")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		lines := "florin valid-after=\"20260101\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5\nnot a line\n"
		if err := os.WriteFile(filepath.Join(dir, "allowed-signers"), []byte(lines), 0o600); err != nil {
			t.Fatal(err)
		}
		var out, errOut bytes.Buffer
		run([]string{"verify", "--json", "--principal", "p", "--trust", dir, absolute(t, "../../../conformance/bundles/passing")}, &out, &errOut)
		var draft struct {
			Observation struct {
				Output string `json:"output"`
			} `json:"observation"`
		}
		if err := json.Unmarshal(out.Bytes(), &draft); err != nil {
			t.Fatalf("%v: %s %s", err, out.String(), errOut.String())
		}
		outputs[i] = draft.Observation.Output
	}
	if outputs[0] != outputs[1] {
		t.Fatalf("two runs from two directories differ:\n%s\n%s", outputs[0], outputs[1])
	}
}
