package printable_test

import (
	"testing"

	"github.com/checkwhy/musai/verify/internal/printable"
)

func TestControlBidiAndInvalidBytesAreEscapedAndTheRestIsKept(t *testing.T) {
	cases := map[string]string{
		"plain text · with é and 中":   "plain text · with é and 中",
		"a\x1b[2Kb":                   `a\u001b[2Kb`,
		"line\rover\nnext\ttab":       `line\u000dover\u000anext\u0009tab`,
		"del\x7f and c1\u0085":        `del\u007f and c1\u0085`,
		"right\u202eto-left\u2066iso": `right\u202eto-left\u2066iso`,
		"broken \xff byte":            `broken \xff byte`,
	}
	for in, want := range cases {
		if got := printable.String(in); got != want {
			t.Errorf("String(%q) = %q, want %q", in, got, want)
		}
	}
}
