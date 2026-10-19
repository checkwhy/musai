// Package workspacetest builds a musai workspace for tests from testdata/main and testdata/scope.
package workspacetest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// New builds the workspace in a temporary directory, skipping where git is not on PATH.
func New(t testing.TB) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH: the workspace is built with git itself")
	}
	dir := t.TempDir()
	if err := Build(dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

// Build writes the workspace's git repository at dir/.musai.
func Build(dir string) error {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		return errors.New("workspacetest: its own source path is unknown")
	}
	data := filepath.Join(filepath.Dir(self), "testdata")
	gitDir := filepath.Join(dir, ".musai")
	if _, err := git(gitDir, "", "", "init", "--quiet", "--bare", "--initial-branch=main", gitDir); err != nil {
		return err
	}
	for branch, tree := range map[string]string{"main": "main", "scope/default": "scope"} {
		if err := commitTree(gitDir, filepath.Join(data, tree), branch); err != nil {
			return err
		}
	}
	return nil
}

// AddBlob commits data to the workspace's blobs branch at <xx>/<hex> and answers the hex.
func AddBlob(t testing.TB, dir string, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:])
	root := t.TempDir()
	shard := filepath.Join(root, name[:2])
	if err := os.MkdirAll(shard, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shard, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := commitTree(filepath.Join(dir, ".musai"), root, "blobs"); err != nil {
		t.Fatal(err)
	}
	return name
}

func commitTree(gitDir, root, branch string) error {
	index := filepath.Join(gitDir, "index-"+strings.ReplaceAll(branch, "/", "-"))
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		blob, err := git(gitDir, "", "", "hash-object", "-w", "--no-filters", path)
		if err != nil {
			return err
		}
		_, err = git(gitDir, index, "", "update-index", "--add", "--cacheinfo", "100644,"+blob+","+filepath.ToSlash(rel))
		return err
	})
	if err != nil {
		return err
	}
	tree, err := git(gitDir, index, "", "write-tree")
	if err != nil {
		return err
	}
	commit, err := git(gitDir, "", "seed "+branch+"\n", "commit-tree", tree)
	if err != nil {
		return err
	}
	if _, err := git(gitDir, "", "", "update-ref", "refs/heads/"+branch, commit); err != nil {
		return err
	}
	return os.Remove(index)
}

func git(gitDir, index, stdin string, args ...string) (string, error) {
	if args[0] != "init" {
		args = append([]string{"--git-dir", gitDir}, args...)
	}
	cmd := exec.Command("git", args...)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@example.org", "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z",
		"GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@example.org", "GIT_COMMITTER_DATE=2026-01-01T00:00:00Z")
	if index != "" {
		cmd.Env = append(cmd.Env, "GIT_INDEX_FILE="+index)
	}
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %v: %w", args, err)
	}
	return strings.TrimSpace(string(out)), nil
}
