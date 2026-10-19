//go:build wasm

package source

import (
	"fmt"
	"path/filepath"
)

// openWorkspace refuses a workspace on a WebAssembly target, which reads
// bundles and zips only: git's object store stays out of the size budget a
// page or a worker loads.
func openWorkspace(path, _ string) (*Source, repository, error) {
	if isRepository(path) || isRepository(filepath.Join(path, ".musai")) {
		return nil, nil, fmt.Errorf("%s is a musai workspace, which this build does not read; export a bundle from it: %w", path, ErrNotASource)
	}
	return nil, nil, fmt.Errorf("%s: %w", path, ErrNotASource)
}
