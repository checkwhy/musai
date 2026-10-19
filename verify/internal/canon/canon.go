// Package canon computes record ids and blob ids the way the musai kernel
// does: the SHA-256 of a value's RFC 8785 canonical bytes, or of a blob's
// raw bytes, spelled sha256:<64 lowercase hex>.
package canon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"regexp"
	"strings"
)

// IDPattern is the one spelling a record id or a blob id takes.
var IDPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

const prefix = "sha256:"

// IsID reports whether s is an id in its entirety.
func IsID(s string) bool {
	return IDPattern.MatchString(s)
}

// Hex returns the digest of an id without its algorithm.
func Hex(id string) string {
	return strings.TrimPrefix(id, prefix)
}

// Canonical returns the RFC 8785 canonical form of a JSON text. It refuses
// a text that is not valid JSON, not valid UTF-8, holds a lone surrogate or
// repeats a key within one object.
func Canonical(data []byte) ([]byte, error) {
	value := jsontext.Value(append([]byte(nil), data...))
	if err := value.Canonicalize(); err != nil {
		return nil, err
	}
	return value, nil
}

// RecordID returns the id of a JSON text and its canonical bytes.
func RecordID(data []byte) (id string, canonical []byte, err error) {
	canonical, err = Canonical(data)
	if err != nil {
		return "", nil, err
	}
	return BlobID(canonical), canonical, nil
}

// BlobID returns the id of raw bytes: their digest, with nothing to
// canonicalise.
func BlobID(data []byte) string {
	sum := sha256.Sum256(data)
	return prefix + hex.EncodeToString(sum[:])
}
