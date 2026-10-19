package source

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"path"
	"slices"
	"strings"
	"testing/fstest"
)

// maxExpanded bounds what an archive may expand to, so a small upload cannot
// exhaust the memory of the tab or the host reading it.
const maxExpanded = 512 << 20

// errExpands refuses an archive whose declared sizes pass maxExpanded,
// which both formats' readers hold their entries to.
var errExpands = fmt.Errorf("%w: it expands past %d MiB", ErrNotASource, maxExpanded>>20)

// caseTwins refuses two names a case-folding filesystem unpacks as one, since
// the bundle would then digest one way as an archive and another unpacked.
func caseTwins(names []string) error {
	seen := map[string]string{}
	for _, name := range names {
		folded := strings.ToLower(name)
		if other, ok := seen[folded]; ok {
			return fmt.Errorf("%w: %s and %s differ only by case", ErrNotASource, other, name)
		}
		seen[folded] = name
	}
	return nil
}

// FromArchive reads a bundle from the bytes of a zip, a gzipped tar or a
// plain tar, told apart by their leading bytes rather than by any name.
func FromArchive(data []byte) (*Source, error) {
	switch {
	case bytes.HasPrefix(data, []byte("PK\x03\x04")), bytes.HasPrefix(data, []byte("PK\x05\x06")):
		return FromZip(data)
	case bytes.HasPrefix(data, []byte{0x1f, 0x8b}):
		unzipped, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrNotASource, err)
		}
		return fromTar(unzipped)
	case len(data) >= 263 && string(data[257:262]) == "ustar":
		return fromTar(bytes.NewReader(data))
	default:
		return nil, fmt.Errorf("%w: neither a zip nor a tar", ErrNotASource)
	}
}

// fromTar reads a tar's entries into memory as a tree. Only regular files
// and directories inside the archive's root are read, past the comment
// header git archive writes; a link, a device, a path escaping the root,
// a name given twice, an entry beneath a file, or an archive ending inside
// an entry refuses the whole archive, since a bundle whose tree depends on
// how it is unpacked has no one digest. An archive whose entries all sit
// under one folder is read as that folder.
func fromTar(r io.Reader) (*Source, error) {
	archive := tar.NewReader(r)
	files := fstest.MapFS{}
	var expanded int64
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrNotASource, err)
		}
		if header.Size > maxExpanded-512-expanded {
			return nil, errExpands
		}
		expanded += 512 + header.Size
		if header.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(header.Name, "./"), "/")
		if name == "" || name == "." {
			continue
		}
		if !fs.ValidPath(name) || path.Clean(name) != name {
			return nil, fmt.Errorf("%w: %s is not a path inside the archive", ErrNotASource, header.Name)
		}
		if _, seen := files[name]; seen {
			return nil, fmt.Errorf("%w: %s appears twice", ErrNotASource, name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			files[name] = &fstest.MapFile{Mode: fs.ModeDir | 0o755}
		case tar.TypeReg:
			data, err := io.ReadAll(archive)
			if err != nil {
				return nil, fmt.Errorf("%w: %s: %w", ErrNotASource, name, err)
			}
			files[name] = &fstest.MapFile{Data: data, Mode: 0o644}
		default:
			return nil, fmt.Errorf("%w: %s is not a regular file", ErrNotASource, name)
		}
	}
	for name := range files {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if held, ok := files[parent]; ok && !held.Mode.IsDir() {
				return nil, fmt.Errorf("%w: %s lies beneath the file %s", ErrNotASource, name, parent)
			}
		}
	}
	if err := caseTwins(slices.Sorted(maps.Keys(files))); err != nil {
		return nil, err
	}
	return unwrapped(files)
}

// archiverLitter is what macOS's archiver and Finder leave beside a folder.
var archiverLitter = map[string]bool{"__MACOSX": true, ".DS_Store": true}

// unwrapped reads a tree as a bundle, or as the one folder it holds where
// that folder is the bundle.
func unwrapped(root fs.FS) (*Source, error) {
	if isBundle(root) {
		return fromBundle(root), nil
	}
	entries, err := fs.ReadDir(root, ".")
	if err != nil {
		return nil, ErrNotASource
	}
	entries = slices.DeleteFunc(entries, func(entry fs.DirEntry) bool { return archiverLitter[entry.Name()] })
	if len(entries) != 1 || !entries[0].IsDir() {
		return nil, ErrNotASource
	}
	sub, err := fs.Sub(root, entries[0].Name())
	if err != nil || !isBundle(sub) {
		return nil, ErrNotASource
	}
	return fromBundle(sub), nil
}
