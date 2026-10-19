package source

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"slices"
	"strings"
)

// Digest is the SHA-256, in hex, of what sha256sum prints over every
// regular file of a tree sorted by path bytewise: a stranger reproduces it
// with coreutils over a bundle's directory, and a workspace digests alike
// with the bundle exported from it.
func Digest(fsys fs.FS) (string, error) {
	var paths []string
	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	slices.Sort(paths)
	var listing strings.Builder
	for _, path := range paths {
		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(&listing, "%s  %s\n", hex.EncodeToString(sum[:]), path)
	}
	sum := sha256.Sum256([]byte(listing.String()))
	return hex.EncodeToString(sum[:]), nil
}
