// Package sig verifies an attestation's detached SSH signature the way
// `ssh-keygen -Y verify` does against an allowed-signers file read by the
// kernel's rules: the signature's own namespace and cryptography first,
// then a line naming the principal with the signing key, whose namespaces
// and validity window admit the signature at the attestation's own time.
package sig

import (
	"crypto/elliptic"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Signer is one usable line of an allowed-signers file.
type Signer struct {
	// Principals is the line's comma-separated list of literal principals.
	Principals string
	// Key is the signer's key; where it is nil, Fingerprint names the key
	// by its SHA256 fingerprint instead, as a pin a person handed over.
	Key           ssh.PublicKey
	Fingerprint   string
	CertAuthority bool
	// Namespaces is the pattern list the line admits, when HasNamespaces;
	// an empty list admits none.
	Namespaces    string
	HasNamespaces bool
	// ValidAfter and ValidBefore bound the line's window; zero is unbounded.
	ValidAfter  time.Time
	ValidBefore time.Time
	// Line is the line's number in the file, from 1; zero for a signer not
	// read from a file.
	Line int
	// Origin says where the signer was trusted from, for a person reading
	// a verdict.
	Origin string
}

// KeyPrefix starts a principal naming a key by its fingerprint, as a
// record names its signer.
const KeyPrefix = "key:"

// OwnKeyForm is the principal naming the line's own key.
func (s Signer) OwnKeyForm() string {
	if s.Key == nil {
		return KeyPrefix + s.Fingerprint
	}
	return KeyPrefix + ssh.FingerprintSHA256(s.Key)
}

// Alias is the first name a line binding the key principal lists beside
// it, or "".
func Alias(signers []Signer, principal string) string {
	for _, signer := range signers {
		names := strings.Split(signer.Principals, ",")
		if signer.OwnKeyForm() != principal || !slices.Contains(names, principal) {
			continue
		}
		for _, name := range names {
			if !strings.HasPrefix(name, KeyPrefix) {
				return name
			}
		}
	}
	return ""
}

// The classes of reason a line is refused for, named alike by the kernel.
const (
	RefusedUnreadCharacter  = "unread-character"
	RefusedIncomplete       = "incomplete"
	RefusedPrincipalPattern = "principal-pattern"
	RefusedPrincipalQuoted  = "principal-quoted"
	RefusedOptionUnknown    = "option-unknown"
	RefusedOptionUnquoted   = "option-unquoted"
	RefusedOptionRepeated   = "option-repeated"
	RefusedTime             = "option-time"
	RefusedWindowEmpty      = "window-empty"
	RefusedKeyTypeUnknown   = "key-type-unknown"
	RefusedKeyInvalid       = "key-invalid"
	RefusedKeyForeign       = "key-foreign"
)

// LineError is a line refused, with the class of its reason where the
// kernel's rules refused it.
type LineError struct {
	Line   int
	Class  string
	Reason string
}

func (e LineError) Error() string {
	if e.Class == "" {
		return fmt.Sprintf("line %d: %s", e.Line, e.Reason)
	}
	return fmt.Sprintf("line %d: %s (%s)", e.Line, e.Reason, e.Class)
}

type refusal struct{ class, reason string }

// ParseAllowedSigners reads a file by the kernel's rules, skipping blank and
// comment lines; a refused line is a LineError and stops none after it.
func ParseAllowedSigners(data []byte) ([]Signer, []LineError) {
	var signers []Signer
	var problems []LineError
	for i, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimRight(strings.TrimLeft(raw, " \t"), " \t\r")
		if line == "" || line[0] == '#' {
			continue
		}
		signer, refused := readLine(line)
		if refused != nil {
			problems = append(problems, LineError{Line: i + 1, Class: refused.class, Reason: refused.reason})
			continue
		}
		signer.Line, signer.Origin = i+1, fmt.Sprintf("allowed-signers line %d", i+1)
		signers = append(signers, signer)
	}
	return signers, problems
}

// unreadCharacter is what OpenSSH reads as part of a name though it reads
// as a space elsewhere: controls, Unicode's spaces and the byte-order mark.
var unreadCharacter = regexp.MustCompile(`[\x00-\x20\x7f-\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`)

// keyFields is each key type OpenSSH 9.6 reads, and the fields its blob
// holds after the type's own name.
var keyFields = map[string]int{
	"ssh-ed25519":                        1,
	"sk-ssh-ed25519@openssh.com":         2,
	"ssh-rsa":                            2,
	"ssh-dss":                            4,
	"ecdsa-sha2-nistp256":                2,
	"ecdsa-sha2-nistp384":                2,
	"ecdsa-sha2-nistp521":                2,
	"sk-ecdsa-sha2-nistp256@openssh.com": 3,
}

// retiredKeyType is read by no OpenSSH since 10, so a line naming one is
// trust a current OpenSSH cannot check.
const retiredKeyType = "ssh-dss"

func readLine(line string) (Signer, *refusal) {
	if strings.Contains(line, "\x00") {
		return Signer{}, &refusal{RefusedUnreadCharacter, "a NUL, where OpenSSH ends the line"}
	}
	tokens := splitOutsideQuotes(line, " \t", true)
	options, at := "", 1
	if len(tokens) > 1 {
		if _, isType := keyFields[tokens[1]]; !isType {
			options, at = tokens[1], 2
		}
	}
	if len(tokens) < at+2 {
		return Signer{}, &refusal{RefusedIncomplete, "no principals, options and key"}
	}
	principals, keyType, encoded := tokens[0], tokens[at], tokens[at+1]
	if unread := unreadCharacter.FindString(principals); unread != "" {
		return Signer{}, &refusal{RefusedUnreadCharacter, fmt.Sprintf("principals holding U+%04X, which OpenSSH reads as a name's", []rune(unread)[0])}
	}
	// OpenSSH matches these as patterns, so a line read as granting may match nobody there.
	if strings.ContainsAny(principals, "!*?") {
		return Signer{}, &refusal{RefusedPrincipalPattern, "principals OpenSSH matches as patterns, " + principals}
	}
	// OpenSSH strips the quotes and ends the principals at the closing one, reading other names.
	if strings.Contains(principals, `"`) {
		return Signer{}, &refusal{RefusedPrincipalQuoted, "principals OpenSSH reads without their quotes, " + principals}
	}
	signer := Signer{Principals: principals}
	if at == 2 {
		if refused := signer.parseOptions(options); refused != nil {
			return Signer{}, refused
		}
	}
	if _, known := keyFields[keyType]; !known {
		return Signer{}, &refusal{RefusedKeyTypeUnknown, "a key type OpenSSH does not read, " + keyType}
	}
	if keyType == retiredKeyType {
		return Signer{}, &refusal{RefusedKeyTypeUnknown, "a key type OpenSSH no longer reads, " + keyType}
	}
	key, ok := keyOf(keyType, encoded)
	if !ok {
		return Signer{}, &refusal{RefusedKeyInvalid, "a key that is no " + keyType + " key OpenSSH reads"}
	}
	signer.Key = key
	own := signer.OwnKeyForm()
	for _, member := range strings.Split(principals, ",") {
		if strings.HasPrefix(member, KeyPrefix) && member != own {
			return Signer{}, &refusal{RefusedKeyForeign, fmt.Sprintf("the principal %s beside the key %s, and one key never speaks as another", member, own)}
		}
	}
	return signer, nil
}

// splitOutsideQuotes splits s at any of seps outside double quotes, which
// stay in the parts; dropEmpty drops the empty parts runs of seps leave.
func splitOutsideQuotes(s, seps string, dropEmpty bool) []string {
	var parts []string
	quoted, start := false, 0
	for i := 0; i <= len(s); i++ {
		if i < len(s) && s[i] == '"' {
			quoted = !quoted
		}
		if i == len(s) || (!quoted && strings.IndexByte(seps, s[i]) != -1) {
			if part := s[start:i]; part != "" || !dropEmpty {
				parts = append(parts, part)
			}
			start = i + 1
		}
	}
	return parts
}

// ParseKey reads a public key written as its type and base64 blob, with
// anything after them ignored, as an authorized key without options.
func ParseKey(s string) (ssh.PublicKey, error) {
	fields := strings.Fields(s)
	if len(fields) < 2 {
		return nil, errors.New("no key")
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil {
		return nil, err
	}
	key, err := ssh.ParsePublicKey(blob)
	if err != nil {
		return nil, err
	}
	if key.Type() != fields[0] {
		return nil, fmt.Errorf("key type %s is spelled %s", key.Type(), fields[0])
	}
	return key, nil
}

var strictBase64 = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// keyOf reads strict base64 of a keyType blob OpenSSH reads: its name, then
// the fields the type holds, each as the type holds it.
func keyOf(keyType, encoded string) (ssh.PublicKey, bool) {
	if !strictBase64.MatchString(encoded) || len(encoded)%4 != 0 {
		return nil, false
	}
	blob, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, false
	}
	var fields [][]byte
	for rest := blob; len(rest) > 0; {
		if len(rest) < 4 || uint64(binary.BigEndian.Uint32(rest)) > uint64(len(rest)-4) {
			return nil, false
		}
		length := binary.BigEndian.Uint32(rest)
		fields, rest = append(fields, rest[4:4+length]), rest[4+length:]
	}
	if len(fields) == 0 || string(fields[0]) != keyType || len(fields)-1 != keyFields[keyType] {
		return nil, false
	}
	held := len(fields[1]) == 32
	switch curve := nistCurve.FindString(keyType); {
	case curve != "":
		held = string(fields[1]) == curve && onCurve(curve, fields[2])
	case keyType == "ssh-rsa":
		held = holdsRSAKey(fields[1], fields[2])
	}
	if !held {
		return nil, false
	}
	// The checks above leave nothing for x/crypto's parser to refuse.
	key, err := ssh.ParsePublicKey(blob)
	return key, err == nil
}

var nistCurve = regexp.MustCompile(`nistp\d+`)

var curves = map[string]*elliptic.CurveParams{
	"nistp256": elliptic.P256().Params(),
	"nistp384": elliptic.P384().Params(),
	"nistp521": elliptic.P521().Params(),
}

// onCurve is an uncompressed point on curve as OpenSSH's validate_public
// takes one: each coordinate over half the order's bits and short of it less one.
func onCurve(curve string, point []byte) bool {
	params := curves[curve]
	size := (params.BitSize + 7) / 8
	if len(point) != 1+2*size || point[0] != 4 {
		return false
	}
	x, y := new(big.Int).SetBytes(point[1:1+size]), new(big.Int).SetBytes(point[1+size:])
	limit := new(big.Int).Sub(params.N, big.NewInt(1))
	for _, coordinate := range []*big.Int{x, y} {
		if coordinate.BitLen() <= params.N.BitLen()/2 || coordinate.Cmp(limit) >= 0 {
			return false
		}
	}
	right := new(big.Int).Mul(x, x)
	right.Mul(right, x).Sub(right, new(big.Int).Mul(x, big.NewInt(3))).Add(right, params.B)
	left := new(big.Int).Mul(y, y)
	return left.Sub(left, right).Mod(left, params.P).Sign() == 0
}

// canonicalMpint is an SSH mpint in its one canonical form: OpenSSH
// fingerprints the key it re-encodes, so a padded one names another key.
func canonicalMpint(field []byte) (*big.Int, bool) {
	if len(field) > 0 && (field[0]&0x80 != 0 || (field[0] == 0 && (len(field) == 1 || field[1]&0x80 == 0))) {
		return nil, false
	}
	return new(big.Int).SetBytes(field), true
}

// holdsRSAKey is an RSA key OpenSSH reads, of 1024 to 16384 bits, whose
// exponent is odd, at least 3 and of at most 24 bits, as x/crypto parses.
func holdsRSAKey(exponent, modulus []byte) bool {
	e, eOK := canonicalMpint(exponent)
	n, nOK := canonicalMpint(modulus)
	return eOK && nOK && e.Cmp(big.NewInt(3)) >= 0 && e.Bit(0) == 1 && e.BitLen() <= 24 &&
		n.BitLen() >= 1024 && n.BitLen() <= 16384
}

// parseOptions reads options as the kernel does: split at commas outside
// quotes, each value quoted, none twice, times in UTC.
func (s *Signer) parseOptions(options string) *refusal {
	seen := map[string]bool{}
	for _, spec := range splitOutsideQuotes(options, ",", false) {
		name, quoted, valued := strings.Cut(spec, "=")
		name = asciiLower(name)
		if name == "cert-authority" && !valued {
			s.CertAuthority = true
			continue
		}
		if !valued || (name != "namespaces" && name != "valid-after" && name != "valid-before") {
			shown := spec
			if shown == "" {
				shown = "an empty one"
			}
			return &refusal{RefusedOptionUnknown, "an option OpenSSH does not read, " + shown}
		}
		// OpenSSH reads a backslash before the closing quote as escaping it, so the value never ends.
		if len(quoted) < 2 || quoted[0] != '"' || quoted[len(quoted)-1] != '"' ||
			strings.Contains(quoted[1:len(quoted)-1], `"`) || strings.HasSuffix(quoted, `\"`) {
			return &refusal{RefusedOptionUnquoted, "the option " + name + " with a value not in quotes"}
		}
		if seen[name] {
			return &refusal{RefusedOptionRepeated, "the option " + name + " more than once"}
		}
		seen[name] = true
		value := quoted[1 : len(quoted)-1]
		if name == "namespaces" {
			s.Namespaces, s.HasNamespaces = value, true
			continue
		}
		at, ok := parseTime(value)
		if !ok {
			return &refusal{RefusedTime, "the option " + name + " with no time in UTC OpenSSH reads"}
		}
		if name == "valid-after" {
			s.ValidAfter = at
		} else {
			s.ValidBefore = at
		}
	}
	if !s.ValidAfter.IsZero() && !s.ValidBefore.IsZero() && !s.ValidBefore.After(s.ValidAfter) {
		return &refusal{RefusedWindowEmpty, "a window closing before it opens"}
	}
	return nil
}

// asciiLower lowers ASCII letters only, as OpenSSH's strncasecmp compares:
// Unicode folding would read namespaceſ as namespaces.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

var utcTime = regexp.MustCompile(`(?i)^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:z|utc)$`)

// parseTime is OpenSSH's parse_absolute_time over a UTC time after the epoch
// and short of a leap second, normalised as mktime normalises it.
func parseTime(s string) (time.Time, bool) {
	parts := utcTime.FindStringSubmatch(s)
	if parts == nil {
		return time.Time{}, false
	}
	fields := make([]int, 6)
	for i, part := range parts[1:] {
		fields[i], _ = strconv.Atoi(part)
	}
	limits := [6][2]int{{1970, 9999}, {1, 12}, {1, 31}, {0, 23}, {0, 59}, {0, 59}}
	for i, field := range fields {
		if field < limits[i][0] || field > limits[i][1] {
			return time.Time{}, false
		}
	}
	at := time.Date(fields[0], time.Month(fields[1]), fields[2], fields[3], fields[4], fields[5], 0, time.UTC)
	return at, at.Unix() > 0
}
