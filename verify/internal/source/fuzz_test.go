package source_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/checkwhy/musai/verify/internal/source"
)

func FuzzAnyArchiveBytesOpenOrAreRefusedNeverAPanic(f *testing.F) {
	f.Add(tarOf(f, entriesOf(f, ""), true))
	f.Add(tarOf(f, entriesOf(f, "passing/"), false))
	f.Add(zipOf(f, passing, ""))
	f.Fuzz(func(t *testing.T, data []byte) {
		src, err := source.FromArchive(data)
		if err != nil {
			if !errors.Is(err, source.ErrNotASource) {
				t.Fatalf("an archive refused with %v, not as a source to fix", err)
			}
			return
		}
		// A zip is read lazily, so bytes damaged inside an entry surface as
		// a file the checks report unreadable; a tar is read whole at open.
		if _, err := source.Digest(src.Bundle); err != nil && !bytes.HasPrefix(data, []byte("PK")) {
			t.Fatalf("a tar that opened could not be digested: %v", err)
		}
	})
}
