package sig_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/sig"
)

func FuzzAllowedSignersNeverPanicsAndNamesRealLines(f *testing.F) {
	bundles, err := filepath.Glob("../../../conformance/bundles/*/allowed-signers")
	if err != nil {
		f.Fatal(err)
	}
	for _, path := range bundles {
		data, err := os.ReadFile(path)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(data)
	}
	f.Add([]byte(`"a b",c namespaces="x,y",valid-after="20260101Z" ssh-ed25519 AAAA`))
	f.Fuzz(func(t *testing.T, data []byte) {
		lines := strings.Count(string(data), "\n") + 1
		signers, problems := sig.ParseAllowedSigners(data)
		for _, s := range signers {
			if s.Line < 1 || s.Line > lines || s.Key == nil {
				t.Fatalf("signer %+v names no line of %d", s, lines)
			}
		}
		for _, p := range problems {
			if p.Line < 1 || p.Line > lines {
				t.Fatalf("problem %+v names no line of %d", p, lines)
			}
		}
	})
}
