// Package gitrepo reads a musai workspace's bare git repository as file
// trees: a scope branch's records and the trust branch's files, each at a
// commit. It is the one package that touches go-git, and it touches only
// its storage and object layers.
package gitrepo

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"slices"
	"time"

	"github.com/go-git/go-billy/v5/osfs"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/storage/filesystem"
)

// ErrNoSuchCommit reports a name that is neither a branch nor a commit of the repository.
var ErrNoSuchCommit = errors.New("no such branch or commit")

// Repo is a bare git repository read through go-git's storage layer.
type Repo struct {
	storage *filesystem.Storage
}

// Open reads the bare repository at gitDir.
func Open(gitDir string) *Repo {
	return &Repo{storage: filesystem.NewStorage(osfs.New(gitDir), cache.NewObjectLRUDefault())}
}

var fullHash = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Tree returns the file tree of a branch's tip or of a commit named by its
// full hash, with the commit's hash.
func (r *Repo) Tree(name string) (fs.FS, string, error) {
	hash, err := r.resolve(name)
	if err != nil {
		return nil, "", err
	}
	commit, err := object.GetCommit(r.storage, hash)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", name, ErrNoSuchCommit)
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, "", fmt.Errorf("reading the tree of %s: %w", name, err)
	}
	return &treeFS{storage: r.storage, root: tree}, hash.String(), nil
}

// Branches returns the names of the repository's branches, sorted.
func (r *Repo) Branches() ([]string, error) {
	refs, err := r.storage.IterReferences()
	if err != nil {
		return nil, err
	}
	var names []string
	err = refs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Name().IsBranch() {
			names = append(names, ref.Name().Short())
		}
		return nil
	})
	slices.Sort(names)
	return names, err
}

func (r *Repo) resolve(name string) (plumbing.Hash, error) {
	if ref, err := r.storage.Reference(plumbing.NewBranchReferenceName(name)); err == nil {
		return ref.Hash(), nil
	}
	if fullHash.MatchString(name) {
		return plumbing.NewHash(name), nil
	}
	return plumbing.ZeroHash, fmt.Errorf("%s: %w", name, ErrNoSuchCommit)
}

type treeFS struct {
	storage *filesystem.Storage
	root    *object.Tree
}

func (t *treeFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	if name == "." {
		return t.dir(name, t.root), nil
	}
	entry, err := t.root.FindEntry(name)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	if entry.Mode == filemode.Dir {
		sub, err := object.GetTree(t.storage, entry.Hash)
		if err != nil {
			return nil, &fs.PathError{Op: "open", Path: name, Err: err}
		}
		return t.dir(name, sub), nil
	}
	blob, err := object.GetBlob(t.storage, entry.Hash)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	reader, err := blob.Reader()
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	return &blobFile{info: info{name: path.Base(name), size: blob.Size, mode: fileMode(entry.Mode)}, reader: reader}, nil
}

func fileMode(mode filemode.FileMode) fs.FileMode {
	switch mode {
	case filemode.Dir:
		return fs.ModeDir | 0o755
	case filemode.Symlink:
		return fs.ModeSymlink | 0o777
	case filemode.Submodule:
		return fs.ModeIrregular
	case filemode.Executable:
		return 0o755
	}
	return 0o644
}

func (t *treeFS) dir(name string, tree *object.Tree) *dirFile {
	entries := make([]fs.DirEntry, 0, len(tree.Entries))
	for _, entry := range tree.Entries {
		entries = append(entries, fs.FileInfoToDirEntry(info{name: entry.Name, mode: fileMode(entry.Mode)}))
	}
	slices.SortFunc(entries, func(a, b fs.DirEntry) int { return cmp.Compare(a.Name(), b.Name()) })
	return &dirFile{info: info{name: path.Base(name), mode: fs.ModeDir | 0o755}, entries: entries}
}

type info struct {
	name string
	size int64
	mode fs.FileMode
}

func (i info) Name() string      { return i.name }
func (i info) Size() int64       { return i.size }
func (i info) Mode() fs.FileMode { return i.mode }
func (info) ModTime() time.Time  { return time.Time{} }
func (i info) IsDir() bool       { return i.mode.IsDir() }
func (info) Sys() any            { return nil }

type blobFile struct {
	info   info
	reader io.ReadCloser
}

func (f *blobFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *blobFile) Read(p []byte) (int, error) { return f.reader.Read(p) }
func (f *blobFile) Close() error               { return f.reader.Close() }

type dirFile struct {
	info    info
	entries []fs.DirEntry
	offset  int
}

func (d *dirFile) Stat() (fs.FileInfo, error) { return d.info, nil }

func (d *dirFile) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.info.name, Err: errors.New("is a directory")}
}

func (d *dirFile) Close() error { return nil }

func (d *dirFile) ReadDir(n int) ([]fs.DirEntry, error) {
	rest := d.entries[d.offset:]
	if n <= 0 {
		d.offset = len(d.entries)
		return rest, nil
	}
	if len(rest) == 0 {
		return nil, io.EOF
	}
	n = min(n, len(rest))
	d.offset += n
	return rest[:n], nil
}
