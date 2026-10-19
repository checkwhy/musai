// Package source opens what a verifier is handed: a bundle as a directory
// or a zip, or a musai workspace's git repository, as one file tree in the
// bundle layout — records/<kind>/<xx>/<yy>/<hex>.json with sidecars beside
// signed attestations, the trust branch's allowed-signers, config.json and
// roles at the root, and blobs/<prefix>/<hex> where blobs are held.
package source

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// ErrNotASource reports a path that holds no bundle, zip or workspace the
// verifier can read, or names a scope or trust source that is not there.
var ErrNotASource = errors.New("not a bundle, a zip or gzipped tar of one, or a musai workspace")

// DefaultScope is the scope a workspace is read at when none is named.
const DefaultScope = "default"

// Options chooses what to read from a workspace.
type Options struct {
	// Scope names the scope branch of a workspace, scope/<Scope>.
	Scope string
}

// Source is one opened input.
type Source struct {
	// Name is the path the source was opened from.
	Name string
	// Bundle is the tree in the bundle layout.
	Bundle fs.FS
	// Trust holds the source's own allowed-signers at its root: a bundle's,
	// or a workspace's trust branch's.
	Trust fs.FS
	// TrustedBy says, for a person reading a verdict, whose allowed-signers
	// the source's own trust is.
	TrustedBy string
	// repo is a workspace's repository, nil for a bundle.
	repo repository
	// HasBlobs says whether the source holds a blobs directory at all.
	HasBlobs bool
}

// Open reads the source at path.
func Open(path string, opts Options) (*Source, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, ErrNotASource)
	}
	var src *Source
	var repo repository
	switch {
	case !info.IsDir():
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		src, err = FromArchive(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	case isBundle(os.DirFS(path)):
		src = fromBundle(os.DirFS(path))
	case isRepository(path), isRepository(filepath.Join(path, ".musai")):
		src, repo, err = openWorkspace(path, opts.Scope)
	default:
		src, err = unwrapped(os.DirFS(path))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	if err != nil {
		return nil, err
	}
	src.Name, src.repo = path, repo
	return src, nil
}

// FromZip reads a bundle from a zip archive's bytes. An archive whose
// entries all sit under one folder is read as that folder.
func FromZip(data []byte) (*Source, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, ErrNotASource
	}
	var expanded uint64
	names := make([]string, 0, len(archive.File))
	for _, file := range archive.File {
		names = append(names, file.Name)
		if file.UncompressedSize64 > maxExpanded-expanded {
			return nil, errExpands
		}
		expanded += file.UncompressedSize64
	}
	if err := caseTwins(names); err != nil {
		return nil, err
	}
	return unwrapped(archive)
}

func fromBundle(fsys fs.FS) *Source {
	return &Source{
		Bundle: fsys, Trust: fsys, HasBlobs: isDir(fsys, "blobs"),
		TrustedBy: "the bundle's own allowed-signers: whoever sent it chose them; pass --trust for keys you chose",
	}
}

func isBundle(fsys fs.FS) bool {
	if isDir(fsys, "records") {
		return true
	}
	_, err := fs.Stat(fsys, "allowed-signers")
	return err == nil
}

func isDir(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && info.IsDir()
}

// repository is a workspace's git repository read as trees at commits.
type repository interface {
	Tree(name string) (fs.FS, string, error)
	Branches() ([]string, error)
}

func isRepository(dir string) bool {
	head, err := os.Stat(filepath.Join(dir, "HEAD"))
	if err != nil || head.IsDir() {
		return false
	}
	objects, err := os.Stat(filepath.Join(dir, "objects"))
	return err == nil && objects.IsDir()
}

// TrustAt reads the trust files of a workspace at a branch or commit.
func (s *Source) TrustAt(name string) (fs.FS, string, error) {
	if s.repo == nil {
		return nil, "", fmt.Errorf("%s is not a workspace, so it has no commits to read trust from: %w", s.Name, ErrNotASource)
	}
	trust, commit, err := s.repo.Tree(name)
	if err != nil {
		return nil, "", fmt.Errorf("trust %s: %w", name, ErrNotASource)
	}
	return trust, commit, nil
}
