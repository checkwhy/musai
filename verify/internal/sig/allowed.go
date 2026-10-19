// Package sig verifies an attestation's detached SSH signature the way
// `ssh-keygen -Y verify` does against an allowed-signers file: the
// signature's own namespace and cryptography first, then a line naming the
// principal with the signing key, whose namespaces and validity window
// admit the signature at the attestation's own time.
package sig

import (
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Signer is one usable line of an allowed-signers file.
type Signer struct {
	// Principals is the line's comma-separated principal pattern list.
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
	// Zoneless is true where a bound was written with no zone and read as
	// UTC, where ssh-keygen would read it in its host's local time.
	Zoneless bool
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

// ForeignKeyForm is a principal on the line naming a key other than the
// line's own, or "": one key never speaks as another.
func (s Signer) ForeignKeyForm() string {
	for _, principal := range strings.Split(s.Principals, ",") {
		if strings.HasPrefix(principal, KeyPrefix) && principal != s.OwnKeyForm() {
			return principal
		}
	}
	return ""
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

// LineError is a line ssh-keygen would log and skip.
type LineError struct {
	Line   int
	Reason string
}

func (e LineError) Error() string {
	return fmt.Sprintf("line %d: %s", e.Line, e.Reason)
}

// ParseAllowedSigners reads an allowed-signers file as OpenSSH's sshsig.c
// does, but for one thing: a timestamp with no Z or UTC suffix is read as
// UTC, so a verdict is the same on every machine, and its line is marked
// Zoneless. Blank and comment lines are skipped silently, malformed ones
// with a LineError, and neither stops the lines after them from being read.
func ParseAllowedSigners(data []byte) ([]Signer, []LineError) {
	var signers []Signer
	var problems []LineError
	for i, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimLeft(raw, whitespace)
		if line == "" || line[0] == '#' {
			continue
		}
		signer, err := parseLine(line)
		if err != nil {
			problems = append(problems, LineError{Line: i + 1, Reason: err.Error()})
			continue
		}
		signer.Line, signer.Origin = i+1, fmt.Sprintf("allowed-signers line %d", i+1)
		signers = append(signers, signer)
	}
	return signers, problems
}

const whitespace = " \t\r\n"

func parseLine(line string) (Signer, error) {
	principals, rest, err := token(line)
	if err != nil {
		return Signer{}, err
	}
	if rest == "" {
		return Signer{}, errors.New("invalid line")
	}
	signer := Signer{Principals: principals}
	key, keyErr := readKey(rest)
	if keyErr != nil {
		options, afterOptions, ok := optionsToken(rest)
		if !ok {
			return Signer{}, errors.New("invalid options")
		}
		if afterOptions == "" {
			return Signer{}, errors.New("missing key")
		}
		if key, err = readKey(afterOptions); err != nil {
			return Signer{}, errors.New("invalid key")
		}
		if err := signer.parseOptions(options); err != nil {
			return Signer{}, fmt.Errorf("bad options: %w", err)
		}
	}
	signer.Key = key
	return signer, nil
}

// token is OpenSSH's strdelimw: a token ends at whitespace, and a double
// quote anywhere in it opens a quoted run, dropped with its closing quote,
// after which the token ends. What follows has its leading whitespace
// skipped.
func token(s string) (string, string, error) {
	end := strings.IndexAny(s, whitespace+`"`)
	if end == -1 {
		return s, "", nil
	}
	if s[end] != '"' {
		return s[:end], strings.TrimLeft(s[end:], whitespace), nil
	}
	quoted := s[end+1:]
	closing := strings.IndexByte(quoted, '"')
	if closing == -1 {
		return "", "", errors.New("unterminated quote")
	}
	return s[:end] + quoted[:closing], strings.TrimLeft(quoted[closing+1:], whitespace), nil
}

// optionsToken is OpenSSH's sshkey_advance_past_options: the options run
// to the first space or tab outside double quotes, a backslash-escaped
// quote opening nothing.
func optionsToken(s string) (string, string, bool) {
	quoted := false
	i := 0
	for ; i < len(s) && (quoted || (s[i] != ' ' && s[i] != '\t')); i++ {
		switch {
		case s[i] == '\\' && i+1 < len(s) && s[i+1] == '"':
			i++
		case s[i] == '"':
			quoted = !quoted
		}
	}
	if quoted {
		return "", "", false
	}
	return s[:i], strings.TrimLeft(s[i:], whitespace), true
}

// ParseKey reads a public key written as its type and base64 blob, with
// anything after them ignored, as an authorized key without options.
func ParseKey(s string) (ssh.PublicKey, error) {
	return readKey(s)
}

// readKey reads a key type, its base64 blob and nothing it requires after.
func readKey(s string) (ssh.PublicKey, error) {
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

// parseOptions is OpenSSH's sshsigopt_parse: options separated by commas,
// names in any case, each value double-quoted, no option twice, nothing
// after a trailing comma, and a window that is not empty.
func (s *Signer) parseOptions(options string) error {
	for options != "" {
		switch {
		case hasFold(options, "cert-authority"):
			s.CertAuthority = true
			options = options[len("cert-authority"):]
		case hasFold(options, "namespaces="):
			if s.HasNamespaces {
				return errors.New(`multiple "namespaces" clauses`)
			}
			value, rest, err := dequote(options[len("namespaces="):])
			if err != nil {
				return err
			}
			s.Namespaces, s.HasNamespaces, options = value, true, rest
		case hasFold(options, "valid-after="), hasFold(options, "valid-before="):
			name := options[:strings.IndexByte(options, '=')]
			value, rest, err := dequote(options[len(name)+1:])
			if err != nil {
				return err
			}
			bound := &s.ValidAfter
			if strings.EqualFold(name, "valid-before") {
				bound = &s.ValidBefore
			}
			if !bound.IsZero() {
				return fmt.Errorf("multiple %q clauses", name)
			}
			at, zoneless, err := parseTime(value)
			if err != nil || at.Unix() <= 0 {
				return fmt.Errorf("invalid %q time", name)
			}
			*bound, options = at, rest
			s.Zoneless = s.Zoneless || zoneless
		default:
			return errors.New("unsupported option")
		}
		if options == "" {
			break
		}
		if options[0] != ',' {
			return errors.New("unknown key option")
		}
		if options = options[1:]; options == "" {
			return errors.New("unexpected end-of-options")
		}
	}
	if !s.ValidAfter.IsZero() && !s.ValidBefore.IsZero() && !s.ValidBefore.After(s.ValidAfter) {
		return errors.New(`"valid-before" time is before "valid-after"`)
	}
	return nil
}

func hasFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// dequote is OpenSSH's opt_dequote: a double-quoted value, in which a
// backslash before a quote escapes it.
func dequote(s string) (string, string, error) {
	if !strings.HasPrefix(s, `"`) {
		return "", "", errors.New("missing start quote")
	}
	var value strings.Builder
	for i := 1; i < len(s); i++ {
		switch {
		case s[i] == '"':
			return value.String(), s[i+1:], nil
		case s[i] == '\\' && i+1 < len(s) && s[i+1] == '"':
			i++
		}
		value.WriteByte(s[i])
	}
	return "", "", errors.New("missing end quote")
}

// parseTime is OpenSSH's parse_absolute_time: YYYYMMDD, YYYYMMDDHHMM or
// YYYYMMDDHHMMSS with an optional Z or UTC suffix in any case, each field
// in strptime's range and the whole normalised as mktime normalises it, so
// the 30th of February is the 2nd of March. Every time is read as UTC; it
// reports whether the suffix that says so was missing.
func parseTime(s string) (time.Time, bool, error) {
	upper := strings.ToUpper(s)
	zoneless := false
	switch {
	case len(s) > 1 && strings.HasSuffix(upper, "Z"):
		s = s[:len(s)-1]
	case len(s) > 3 && strings.HasSuffix(upper, "UTC"):
		s = s[:len(s)-3]
	default:
		zoneless = true
	}
	if len(s) != 8 && len(s) != 12 && len(s) != 14 {
		return time.Time{}, false, fmt.Errorf("not a time: %q", s)
	}
	fields := make([]int, 6)
	limits := [6][2]int{{0, 9999}, {1, 12}, {1, 31}, {0, 23}, {0, 59}, {0, 60}}
	widths := []int{4, 2, 2, 2, 2, 2}
	at := 0
	for i := 0; at < len(s); i++ {
		n, err := strconv.Atoi(s[at : at+widths[i]])
		if err != nil || n < limits[i][0] || n > limits[i][1] || !digits(s[at:at+widths[i]]) {
			return time.Time{}, false, fmt.Errorf("not a time: %q", s)
		}
		fields[i], at = n, at+widths[i]
	}
	return time.Date(fields[0], time.Month(fields[1]), fields[2], fields[3], fields[4], fields[5], 0, time.UTC), zoneless, nil
}

func digits(s string) bool {
	return strings.Trim(s, "0123456789") == ""
}
