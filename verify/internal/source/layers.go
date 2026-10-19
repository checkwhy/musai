//go:build !wasm

package source

import (
	"errors"
	"io"
	"io/fs"
	"slices"
	"strings"
	"time"
)

// layered is file trees read as one: a file is the first layer's that
// holds it, and a directory lists the entries of every layer holding it.
type layered []fs.FS

func (l layered) Open(name string) (fs.File, error) {
	var entries []fs.DirEntry
	isDirectory := false
	for _, layer := range l {
		info, err := fs.Stat(layer, name)
		if err != nil {
			continue
		}
		if !info.IsDir() {
			if isDirectory {
				continue
			}
			return layer.Open(name)
		}
		isDirectory = true
		listed, err := fs.ReadDir(layer, name)
		if err != nil {
			return nil, err
		}
		for _, entry := range listed {
			if !slices.ContainsFunc(entries, func(e fs.DirEntry) bool { return e.Name() == entry.Name() }) {
				entries = append(entries, entry)
			}
		}
	}
	if !isDirectory {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	slices.SortFunc(entries, func(a, b fs.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return &dir{name: name, entries: entries}, nil
}

// mount places a file tree under one directory name.
func mount(at string, fsys fs.FS) fs.FS {
	return mounted{at: at, fsys: fsys}
}

type mounted struct {
	at   string
	fsys fs.FS
}

func (m mounted) Open(name string) (fs.File, error) {
	switch {
	case name == ".":
		return &dir{name: ".", entries: []fs.DirEntry{fs.FileInfoToDirEntry(dirInfo(m.at))}}, nil
	case name == m.at:
		return m.fsys.Open(".")
	case strings.HasPrefix(name, m.at+"/"):
		return m.fsys.Open(strings.TrimPrefix(name, m.at+"/"))
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

type dirInfo string

func (d dirInfo) Name() string     { return string(d) }
func (dirInfo) Size() int64        { return 0 }
func (dirInfo) Mode() fs.FileMode  { return fs.ModeDir | 0o755 }
func (dirInfo) ModTime() time.Time { return time.Time{} }
func (dirInfo) IsDir() bool        { return true }
func (dirInfo) Sys() any           { return nil }

type dir struct {
	name    string
	entries []fs.DirEntry
	offset  int
}

func (d *dir) Stat() (fs.FileInfo, error) { return dirInfo(d.name), nil }

func (d *dir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.name, Err: errors.New("is a directory")}
}

func (d *dir) Close() error { return nil }

func (d *dir) ReadDir(n int) ([]fs.DirEntry, error) {
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
