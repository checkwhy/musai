//go:build !wasm

package source

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/checkwhy/musai/verify/internal/source/gitrepo"
)

// openWorkspace reads a musai workspace: path is its bare repository, or
// the directory holding it as .musai.
func openWorkspace(path, scope string) (*Source, repository, error) {
	gitDir := path
	if !isRepository(gitDir) {
		gitDir = filepath.Join(path, ".musai")
	}
	if !isRepository(gitDir) {
		return nil, nil, fmt.Errorf("%s: %w", path, ErrNotASource)
	}
	repo := gitrepo.Open(gitDir)
	src, err := fromRepository(repo, scope)
	return src, repo, err
}

// fromRepository reads a workspace at a scope: the scope branch's records,
// the trust branch's files and, where the workspace has one, the blobs
// branch's tree, whose <xx>/<hex> layout is a bundle's blobs directory.
func fromRepository(repo repository, scope string) (*Source, error) {
	if scope == "" {
		scope = DefaultScope
	}
	records, _, err := repo.Tree("scope/" + scope)
	if err != nil {
		branches, _ := repo.Branches()
		return nil, fmt.Errorf("scope %q is not in this workspace (branches: %s): %w", scope, strings.Join(branches, ", "), ErrNotASource)
	}
	trust, _, err := repo.Tree("main")
	if err != nil {
		return nil, fmt.Errorf("the workspace has no trust branch main: %w", ErrNotASource)
	}
	// A scope branch contributes its records and nothing else: a file at
	// its root, an allowed-signers above all, is not the trust branch's
	// and never stands in for it.
	scoped, err := fs.Sub(records, "records")
	if err != nil {
		return nil, err
	}
	layers := []fs.FS{mount("records", scoped), trust}
	blobs, _, err := repo.Tree("blobs")
	held := err == nil
	if held {
		layers = append(layers, mount("blobs", blobs))
	} else if !errors.Is(err, gitrepo.ErrNoSuchCommit) {
		return nil, err
	}
	return &Source{
		Bundle: layered(layers), Trust: trust, HasBlobs: held,
		TrustedBy: "the allowed-signers on the workspace's trust branch main",
	}, nil
}
