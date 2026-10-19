package source_test

import (
	"archive/zip"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/workspacetest"
)

const (
	passing   = "../../../conformance/bundles/passing"
	claimPath = "records/claim/92/1e/921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68.json"
)

func recordCount(t *testing.T, fsys fs.FS) int {
	t.Helper()
	count := 0
	err := fs.WalkDir(fsys, "records", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".json") {
			count++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return count
}

func TestADirectoryBundleOpensWithItsRecordsAndTrustFiles(t *testing.T) {
	src, err := source.Open(passing, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if n := recordCount(t, src.Bundle); n != 9 {
		t.Errorf("%d records, want 9", n)
	}
	if _, err := fs.ReadFile(src.Trust, "allowed-signers"); err != nil {
		t.Errorf("no allowed-signers: %v", err)
	}
	if src.HasBlobs {
		t.Error("a bundle with no blobs directory holds blobs")
	}
}

func zipOf(t testing.TB, dir, prefix string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		f, err := w.Create(prefix + filepath.ToSlash(rel))
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

func TestAZipUnderOneFolderOpensAsIfUnwrappedAndDigestsAsItsDirectory(t *testing.T) {
	dirSource, err := source.Open(passing, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	dirDigest, err := source.Digest(dirSource.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"", "passing/"} {
		zipped := filepath.Join(t.TempDir(), "bundle.zip")
		if err := os.WriteFile(zipped, zipOf(t, passing, prefix), 0o600); err != nil {
			t.Fatal(err)
		}
		src, err := source.Open(zipped, source.Options{})
		if err != nil {
			t.Fatalf("prefix %q: %v", prefix, err)
		}
		if n := recordCount(t, src.Bundle); n != 9 {
			t.Errorf("prefix %q: %d records, want 9", prefix, n)
		}
		digest, err := source.Digest(src.Bundle)
		if err != nil {
			t.Fatal(err)
		}
		if digest != dirDigest {
			t.Errorf("prefix %q: zip digests to %s, its directory to %s", prefix, digest, dirDigest)
		}
	}
}

func TestTheDigestIsWhatSha256sumPrintsOverTheSortedListing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the reproduction is a POSIX pipeline")
	}
	if _, err := exec.LookPath("sha256sum"); err != nil {
		t.Skip("sha256sum is not on PATH")
	}
	cmd := exec.Command("sh", "-c", `(cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 sha256sum) | sha256sum`, "sh", passing)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(passing, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	digest, err := source.Digest(src.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Fields(string(out))[0]; digest != want {
		t.Fatalf("digest %s, sha256sum %s", digest, want)
	}
}

func TestAWorkspaceOpensAtItsDefaultScope(t *testing.T) {
	workspace := workspacetest.New(t)
	for _, path := range []string{filepath.Join(workspace, ".musai"), workspace} {
		src, err := source.Open(path, source.Options{})
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if n := recordCount(t, src.Bundle); n != 5 {
			t.Errorf("%s: %d records, want 5", path, n)
		}
		if _, err := fs.ReadFile(src.Bundle, claimPath); err != nil {
			t.Errorf("%s: %v", path, err)
		}
		if _, err := fs.ReadFile(src.Trust, "config.json"); err != nil {
			t.Errorf("%s: the trust branch's config.json is not at the root: %v", path, err)
		}
	}
}

func TestAnAbsentScopeIsAnInvocationToFix(t *testing.T) {
	_, err := source.Open(filepath.Join(workspacetest.New(t), ".musai"), source.Options{Scope: "nowhere"})
	if !errors.Is(err, source.ErrNotASource) {
		t.Fatalf("err = %v, want ErrNotASource", err)
	}
}

func TestAPathHoldingNoBundleIsNotASource(t *testing.T) {
	for _, path := range []string{t.TempDir(), filepath.Join(t.TempDir(), "missing")} {
		if _, err := source.Open(path, source.Options{}); !errors.Is(err, source.ErrNotASource) {
			t.Errorf("%s: err = %v, want ErrNotASource", path, err)
		}
	}
	junk := filepath.Join(t.TempDir(), "junk.zip")
	if err := os.WriteFile(junk, []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Open(junk, source.Options{}); !errors.Is(err, source.ErrNotASource) {
		t.Errorf("junk: err = %v, want ErrNotASource", err)
	}
}

// plantOnScope commits a file at the root of the scope/default branch, as a writer of records could.
func plantOnScope(t *testing.T, name, content string) string {
	t.Helper()
	gitDir := filepath.Join(workspacetest.New(t), ".musai")
	gitBinary, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	git := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command(gitBinary, append([]string{"--git-dir", gitDir}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+filepath.Join(t.TempDir(), "index"),
			"GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@example.org", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@example.org")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	index := filepath.Join(t.TempDir(), "index")
	withIndex := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(gitBinary, append([]string{"--git-dir", gitDir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index,
			"GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@example.org", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@example.org")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	blob := git(content, "hash-object", "-w", "--stdin")
	withIndex("read-tree", "scope/default")
	withIndex("update-index", "--add", "--cacheinfo", "100644,"+blob+","+name)
	tree := withIndex("write-tree")
	commit := withIndex("commit-tree", tree, "-p", "scope/default", "-m", "plant")
	git("", "update-ref", "refs/heads/scope/default", commit)
	return gitDir
}

func TestAScopeBranchCannotShadowTheTrustBranch(t *testing.T) {
	gitDir := plantOnScope(t, "allowed-signers", "florin ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5\n")
	src, err := source.Open(gitDir, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for name, fsys := range map[string]fs.FS{"trust": src.Trust, "bundle": src.Bundle} {
		data, err := fs.ReadFile(fsys, "allowed-signers")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(data) != 0 {
			t.Errorf("the %s's allowed-signers is the scope branch's %q, not the trust branch's empty file", name, data)
		}
	}
}

func TestAWorkspacesBlobsAreReadFromItsBlobsBranch(t *testing.T) {
	workspace := workspacetest.New(t)
	held := workspacetest.AddBlob(t, workspace, []byte("held"))
	stray := strings.Repeat("ab", 32)
	for _, dir := range []string{
		filepath.Join(workspace, ".musai", "blobs", "ab"),
		filepath.Join(workspace, "blobs", "ab"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, stray), []byte("a directory store"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	src, err := source.Open(workspace, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !src.HasBlobs {
		t.Fatal("a workspace with a blobs branch holds no blobs")
	}
	if got, err := fs.ReadFile(src.Bundle, "blobs/"+held[:2]+"/"+held); err != nil || string(got) != "held" {
		t.Errorf("the held blob reads %q, %v", got, err)
	}
	if _, err := fs.ReadFile(src.Bundle, "blobs/ab/"+stray); err == nil {
		t.Error("a blobs directory inside or beside the repository is read as its blob store")
	}
}

func TestAWorkspaceWithNoBlobsBranchHoldsNoBlobs(t *testing.T) {
	src, err := source.Open(workspacetest.New(t), source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if src.HasBlobs {
		t.Error("a workspace with no blobs branch holds blobs")
	}
}

func TestAZipFinderMadeOpensAsItsFolderBesideTheMacOSXSibling(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	folder := zipOf(t, passing, "passing/")
	reader, err := zip.NewReader(bytes.NewReader(folder), int64(len(folder)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range reader.File {
		if err := w.Copy(f); err != nil {
			t.Fatal(err)
		}
	}
	sibling, err := w.Create("__MACOSX/passing/._allowed-signers")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sibling.Write([]byte("a resource fork")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	zipped := filepath.Join(t.TempDir(), "bundle.zip")
	if err := os.WriteFile(zipped, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(zipped, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if n := recordCount(t, src.Bundle); n != 9 {
		t.Errorf("%d records, want 9", n)
	}
}

func TestADirectoryHoldingOneBundleFolderOpensAsThatFolder(t *testing.T) {
	dir := t.TempDir()
	if err := os.CopyFS(filepath.Join(dir, "passing"), os.DirFS(passing)); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(dir, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if n := recordCount(t, src.Bundle); n != 9 {
		t.Errorf("%d records, want 9", n)
	}
}
