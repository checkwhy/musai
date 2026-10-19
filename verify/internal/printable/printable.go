// Package printable makes text read from a record safe to print on a
// terminal: a record is untrusted input, and a control character or a
// bidirectional override in it could rewrite the line a receiver reads.
package printable

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// String escapes every control character, every bidirectional formatting
// character and every byte that is not UTF-8, as \uXXXX or \xXX, and
// keeps everything else.
func String(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			fmt.Fprintf(&b, `\x%02x`, s[i])
		case unsafe(r):
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	return b.String()
}

func unsafe(r rune) bool {
	switch {
	case r < 0x20, r >= 0x7f && r <= 0x9f:
		return true
	case r == 0x061c, r == 0x200e, r == 0x200f, r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	case r == 0x2028, r == 0x2029:
		return true
	}
	return false
}
