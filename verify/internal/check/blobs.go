package check

import (
	"errors"
	"io/fs"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/refs"
)

// Blobs checks that every blob a held record names, where the source holds
// blobs at all, digests to the id that names it. A source holding no blobs
// directory is not asked for any.
func Blobs(index *Index, table refs.Table, fsys fs.FS, held bool) []Finding {
	if !held {
		return nil
	}
	var findings []Finding
	for _, record := range index.Sorted() {
		for _, blob := range table.Kinds[record.Kind].Blobs {
			if blob.When != nil && !holds(record.Value, *blob.When) {
				continue
			}
			for _, v := range refs.At(record.Value, blob.Path) {
				id, ok := v.(string)
				if !ok || !canon.IsID(id) {
					continue
				}
				if finding := checkBlob(fsys, record, blob.Path, id); finding != nil {
					findings = append(findings, *finding)
				}
			}
		}
	}
	return findings
}

func holds(value map[string]any, condition refs.Condition) bool {
	for _, v := range refs.At(value, condition.Path) {
		if v == condition.Equals {
			return true
		}
	}
	return false
}

func checkBlob(fsys fs.FS, record *Record, at, id string) *Finding {
	hex := canon.Hex(id)
	path := "blobs/" + hex[:2] + "/" + hex
	data, err := fs.ReadFile(fsys, path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return &Finding{Code: "blob.absent", Severity: Warning, Path: record.Path, Record: record.ID, At: at, Detail: id + " is not among the blobs the source holds"}
	case err != nil:
		finding := unreadable(path, err)
		return &finding
	}
	if actual := canon.BlobID(data); actual != id {
		return &Finding{Code: "blob.mismatch", Severity: Error, Path: path, Record: record.ID, At: at, Detail: "the blob's bytes digest to " + actual}
	}
	return nil
}
