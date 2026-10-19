package source_test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/source"
)

// tarEntry is one header of a hand-built archive, with the bytes of a regular file.
type tarEntry struct {
	name     string
	typeflag byte
	data     []byte
}

func tarOf(t testing.TB, entries []tarEntry, gzipped bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	var out interface {
		Write([]byte) (int, error)
		Close() error
	}
	if gzipped {
		out = gzip.NewWriter(&buf)
	} else {
		out = nopCloser{&buf}
	}
	w := tar.NewWriter(out)
	for _, e := range entries {
		header := &tar.Header{Name: e.name, Typeflag: e.typeflag, Mode: 0o644, Size: int64(len(e.data))}
		if e.typeflag == tar.TypeXGlobalHeader {
			header = &tar.Header{Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": string(e.data)}}
		}
		if e.typeflag == tar.TypeSymlink || e.typeflag == tar.TypeLink {
			header.Linkname, header.Size = "records", 0
		}
		if e.typeflag == tar.TypeDir {
			header.Size = 0
		}
		if err := w.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := w.Write(e.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type nopCloser struct{ *bytes.Buffer }

func (nopCloser) Close() error { return nil }

// entriesOf reads the passing bundle into archive entries under a prefix, with a directory entry for the prefix itself where there is one.
func entriesOf(t testing.TB, prefix string) []tarEntry {
	t.Helper()
	var entries []tarEntry
	if prefix != "" {
		entries = append(entries, tarEntry{name: prefix, typeflag: tar.TypeDir})
	}
	err := filepath.WalkDir(passing, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(passing, path)
		data, err := os.ReadFile(path)
		entries = append(entries, tarEntry{name: prefix + filepath.ToSlash(rel), typeflag: tar.TypeReg, data: data})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestATarGzipOrPlainAndUnderOneFolderOrNotDigestsAsItsDirectory(t *testing.T) {
	dirSource, err := source.Open(passing, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	want, err := source.Digest(dirSource.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"", "passing/"} {
		for _, gzipped := range []bool{true, false} {
			src, err := source.FromArchive(tarOf(t, entriesOf(t, prefix), gzipped))
			if err != nil {
				t.Fatalf("prefix %q gzipped %v: %v", prefix, gzipped, err)
			}
			if n := recordCount(t, src.Bundle); n != 9 {
				t.Errorf("prefix %q gzipped %v: %d records, want 9", prefix, gzipped, n)
			}
			got, err := source.Digest(src.Bundle)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Errorf("prefix %q gzipped %v: tar digests to %s, its directory to %s", prefix, gzipped, got, want)
			}
		}
	}
}

func TestAPathNamingATarGzOpensItAsABundle(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "bundle.tar.gz")
	if err := os.WriteFile(archive, tarOf(t, entriesOf(t, ""), true), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(archive, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if n := recordCount(t, src.Bundle); n != 9 {
		t.Errorf("%d records, want 9", n)
	}
}

func TestATarEntryThatIsNotAPlainFileInsideItsRootIsNotASource(t *testing.T) {
	good := tarEntry{name: "allowed-signers", typeflag: tar.TypeReg, data: []byte("\n")}
	for name, bad := range map[string]tarEntry{
		"escaping":       {name: "../records/x.json", typeflag: tar.TypeReg, data: []byte("{}")},
		"absolute":       {name: "/records/x.json", typeflag: tar.TypeReg, data: []byte("{}")},
		"symlink":        {name: "records/x.json", typeflag: tar.TypeSymlink},
		"hard link":      {name: "records/x.json", typeflag: tar.TypeLink},
		"twice":          good,
		"beneath a file": {name: "allowed-signers/records/x.json", typeflag: tar.TypeReg, data: []byte("{}")},
	} {
		_, err := source.FromArchive(tarOf(t, []tarEntry{good, bad}, true))
		if !errors.Is(err, source.ErrNotASource) {
			t.Errorf("%s: %v, want ErrNotASource", name, err)
		}
	}
}

func TestBytesThatAreNeitherAZipNorATarAreNotASource(t *testing.T) {
	var gzipped bytes.Buffer
	w := gzip.NewWriter(&gzipped)
	if _, err := w.Write([]byte("not a tar at all, only text that gzip was handed")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"gzip of text": gzipped.Bytes(),
		"plain text":   []byte("hello"),
		"empty":        nil,
		"cut short":    tarOf(t, entriesOf(t, ""), true)[:600],
	} {
		if _, err := source.FromArchive(data); !errors.Is(err, source.ErrNotASource) {
			t.Errorf("%s: %v, want ErrNotASource", name, err)
		}
	}
}

func TestAGitArchiveCommentHeaderIsReadPast(t *testing.T) {
	entries := append([]tarEntry{{name: "pax_global_header", typeflag: tar.TypeXGlobalHeader, data: []byte("0123456789abcdef")}}, entriesOf(t, "")...)
	src, err := source.FromArchive(tarOf(t, entries, false))
	if err != nil {
		t.Fatal(err)
	}
	if n := recordCount(t, src.Bundle); n != 9 {
		t.Errorf("%d records, want 9", n)
	}
}

func TestAnEntryBeneathAFileOfTheSameNameIsNotASource(t *testing.T) {
	signers := tarEntry{name: "allowed-signers", typeflag: tar.TypeReg, data: []byte("\n")}
	entries := []tarEntry{
		{name: "blobs", typeflag: tar.TypeReg, data: []byte("a file")},
		{name: "blobs/ab/abcd", typeflag: tar.TypeReg, data: []byte("a blob")},
	}
	for _, order := range [][]tarEntry{{signers, entries[0], entries[1]}, {signers, entries[1], entries[0]}} {
		if _, err := source.FromArchive(tarOf(t, order, true)); !errors.Is(err, source.ErrNotASource) {
			t.Errorf("%s then %s: %v, want ErrNotASource", order[1].name, order[2].name, err)
		}
	}
}

func TestAnArchiveDeclaringMoreThanABundleCouldHoldIsRefusedBeforeItExpands(t *testing.T) {
	var tarred bytes.Buffer
	tw := tar.NewWriter(&tarred)
	if err := tw.WriteHeader(&tar.Header{Name: "records/huge", Typeflag: tar.TypeReg, Size: 1 << 40, Mode: 0o644}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Flush(); err == nil {
		t.Fatal("a tar declaring more than it holds flushed")
	}
	var zipped bytes.Buffer
	zw := zip.NewWriter(&zipped)
	// The second entry's declared size wraps a running sum of the two back to 2.
	for _, entry := range []struct {
		name string
		size uint64
	}{{"records/small", 4}, {"records/wraps", ^uint64(0) - 1}} {
		raw, err := zw.CreateRaw(&zip.FileHeader{Name: entry.name, Method: zip.Store, UncompressedSize64: entry.size, CompressedSize64: 4})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Write([]byte("tiny")); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	for name, archive := range map[string][]byte{"tar": tarred.Bytes(), "zip": zipped.Bytes()} {
		_, err := source.FromArchive(archive)
		if !errors.Is(err, source.ErrNotASource) || !strings.Contains(err.Error(), "expands past") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAnArchiveHoldingTwoNamesDifferingOnlyByCaseIsRefused(t *testing.T) {
	names := []string{"records/rule/ab/cd/A.json", "records/rule/ab/cd/a.json"}
	var tarred bytes.Buffer
	tw := tar.NewWriter(&tarred)
	var zipped bytes.Buffer
	zw := zip.NewWriter(&zipped)
	for _, name := range names {
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Size: 2, Mode: 0o644}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte("{}")); err != nil {
			t.Fatal(err)
		}
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte("{}")); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	for name, archive := range map[string][]byte{"tar": tarred.Bytes(), "zip": zipped.Bytes()} {
		_, err := source.FromArchive(archive)
		if !errors.Is(err, source.ErrNotASource) || !strings.Contains(err.Error(), "only by case") {
			t.Errorf("%s: %v", name, err)
		}
	}
}
