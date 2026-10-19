//go:build js && wasm

package main

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"syscall/js"
	"testing"
)

func zipOf(t *testing.T, bundle string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	root := "../../conformance/bundles/" + bundle
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		f, err := w.Create(filepath.ToSlash(rel))
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
	return buf.Bytes()
}

func uint8Array(data []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(array, data)
	return array
}

func TestTheFunctionAnswersEveryArgumentWithoutEndingTheRuntime(t *testing.T) {
	zipped := uint8Array(zipOf(t, "passing"))
	cases := []struct {
		name string
		args []js.Value
		want int
	}{
		{"a Uint8Array", []js.Value{zipped, js.ValueOf("page")}, 0},
		{"an ArrayBuffer", []js.Value{zipped.Get("buffer"), js.ValueOf("page")}, 0},
		{"a plain object", []js.Value{js.Global().Get("Object").New(), js.ValueOf("page")}, 2},
		{"a number", []js.Value{js.ValueOf(3), js.ValueOf("page")}, 2},
		{"no principal", []js.Value{zipped}, 2},
		{"bytes that are no zip", []js.Value{uint8Array([]byte("junk")), js.ValueOf("page")}, 2},
		{"options that are no object", []js.Value{zipped, js.ValueOf("page"), js.ValueOf("trust")}, 2},
		{"trust that is no list", []js.Value{zipped, js.ValueOf("page"), js.ValueOf(map[string]any{"trust": "florin=SHA256:x"})}, 2},
		{"trust holding a number", []js.Value{zipped, js.ValueOf("page"), js.ValueOf(map[string]any{"trust": []any{3}})}, 2},
		{"allowed signers that are no text", []js.Value{zipped, js.ValueOf("page"), js.ValueOf(map[string]any{"allowedSigners": 3})}, 2},
		{"a GitHub account a page cannot fetch", []js.Value{zipped, js.ValueOf("page"), js.ValueOf(map[string]any{"trust": []any{"florin=github:florinutz"}})}, 2},
		{"options left undefined", []js.Value{zipped, js.ValueOf("page"), js.Undefined()}, 0},
	}
	for _, c := range cases {
		answer := js.ValueOf(musaiVerify(js.Undefined(), c.args))
		if got := answer.Get("exitCode").Int(); got != c.want {
			t.Errorf("%s: exitCode %d, want %d (%v)", c.name, got, c.want, answer.Get("error"))
		}
	}
}

const florinPin = "florin=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"

func TestTrustTheReceiverGivesStandsInForTheBundlesOwn(t *testing.T) {
	absent := uint8Array(zipOf(t, "principal-absent"))
	allowed, err := os.ReadFile("../../conformance/bundles/passing/allowed-signers")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		options js.Value
		want    int
		trust   string
	}{
		{"its own", js.Undefined(), 3, "the bundle's own allowed-signers: whoever sent it chose them; pass --trust for keys you chose"},
		{"a pinned fingerprint", js.ValueOf(map[string]any{"trust": []any{florinPin}}), 0, "florin's key SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY, pinned"},
		{"pasted allowed signers", js.ValueOf(map[string]any{"allowedSigners": string(allowed)}), 0, "the allowed-signers you gave"},
		{"both", js.ValueOf(map[string]any{"trust": []any{florinPin}, "allowedSigners": string(allowed)}), 0, "florin's key SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY, pinned; the allowed-signers you gave"},
	}
	for _, c := range cases {
		answer := js.ValueOf(musaiVerify(js.Undefined(), []js.Value{absent, js.ValueOf("page"), c.options}))
		if got := answer.Get("exitCode").Int(); got != c.want {
			t.Errorf("%s: exitCode %d, want %d (%v)", c.name, got, c.want, answer.Get("error"))
			continue
		}
		if got := answer.Get("summary").Get("trust").String(); got != c.trust {
			t.Errorf("%s: trust %q, want %q", c.name, got, c.trust)
		}
	}
}

func TestTheAnswerCarriesWhatTheCommandLinesSummarySays(t *testing.T) {
	answer := js.ValueOf(musaiVerify(js.Undefined(), []js.Value{uint8Array(zipOf(t, "passing")), js.ValueOf("page")}))
	summary := answer.Get("summary")
	if summary.Get("records").Int() != 9 || summary.Get("signatures").Int() != 1 {
		t.Fatalf("summary %d records, %d signatures, want 9 and 1", summary.Get("records").Int(), summary.Get("signatures").Int())
	}
}

func TestTheKernelsExportVerifiesAsATarGz(t *testing.T) {
	data, err := os.ReadFile("../../conformance/exports/released.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	answer := js.ValueOf(musaiVerify(js.Undefined(), []js.Value{uint8Array(data), js.ValueOf("page")}))
	if got := answer.Get("exitCode").Int(); got != 0 {
		t.Fatalf("exitCode %d (%v)", got, answer.Get("error"))
	}
	if records := answer.Get("summary").Get("records").Int(); records != 6 {
		t.Fatalf("%d records, want 6", records)
	}
}

func TestAZipDamagedInTransitAnswersAFailedReport(t *testing.T) {
	archive := zipOf(t, "passing")
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	at, err := reader.File[0].DataOffset()
	if err != nil {
		t.Fatal(err)
	}
	archive[at+1] ^= 0xff
	answer := js.ValueOf(musaiVerify(js.Undefined(), []js.Value{uint8Array(archive), js.ValueOf("page")}))
	if got := answer.Get("exitCode").Int(); got != 3 {
		t.Fatalf("exitCode %d (%v), want 3", got, answer.Get("error"))
	}
	if !bytes.Contains([]byte(answer.Get("report").String()), []byte("source.unreadable")) {
		t.Fatalf("the report names no unreadable file: %s", answer.Get("report").String())
	}
}
