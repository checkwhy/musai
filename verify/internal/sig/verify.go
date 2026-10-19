package sig

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/hiddeco/sshsig"
	"golang.org/x/crypto/ssh"
)

// Namespace is the one namespace a musai attestation is signed under.
const Namespace = "musai"

// The codes a failed verification names.
const (
	CodeMalformed             = "sig.malformed"
	CodeCertificate           = "sig.certificate-unsupported"
	CodeNamespace             = "sig.namespace"
	CodeBad                   = "sig.bad"
	CodePrincipalUnknown      = "sig.principal-unknown"
	CodeNamespaceNotPermitted = "sig.namespace-not-permitted"
	CodeNotYetValid           = "sig.not-yet-valid"
	CodeExpired               = "sig.expired"
)

// Outcome is a verification's answer: an empty Code when it verified.
type Outcome struct {
	Code   string
	Detail string
}

// Verify checks an armored signature over message for principal at the
// time at, which is truncated to the second as the kernel hands it to
// ssh-keygen. The signature must name the musai namespace and verify
// under its own key; then some signer line must name the principal with
// that key, admit the namespace and hold the time in its window. Where
// no line admits it, the first failing line that named the principal and
// the key gives the reason.
func Verify(message, armored []byte, principal string, at time.Time, signers []Signer) Outcome {
	signature, err := sshsig.Unarmor(armored)
	if err != nil {
		return Outcome{Code: CodeMalformed, Detail: err.Error()}
	}
	if _, ok := signature.PublicKey.(*ssh.Certificate); ok {
		return Outcome{Code: CodeCertificate, Detail: "the signature was made by a certificate"}
	}
	if signature.Namespace != Namespace {
		return Outcome{Code: CodeNamespace, Detail: fmt.Sprintf("signed under namespace %q, not %q", signature.Namespace, Namespace)}
	}
	if err := sshsig.Verify(bytes.NewReader(message), signature, signature.PublicKey, signature.HashAlgorithm, Namespace); err != nil {
		return Outcome{Code: CodeBad, Detail: "the signature does not verify over the stored bytes: " + err.Error()}
	}
	at = at.Truncate(time.Second)
	var first *Outcome
	for _, signer := range signers {
		if signer.CertAuthority || !signer.holds(signature.PublicKey) || !matchList(principal, signer.Principals) {
			continue
		}
		reason := signer.admits(at)
		if reason.Code == "" {
			fingerprint := ssh.FingerprintSHA256(signature.PublicKey)
			signedBy := fmt.Sprintf("%s (%s)", principal, fingerprint)
			if principal == KeyPrefix+fingerprint {
				signedBy = principal
			}
			if alias := Alias([]Signer{signer}, principal); alias != "" {
				signedBy = fmt.Sprintf("%s (%s)", alias, principal)
			}
			return Outcome{Detail: fmt.Sprintf("signed by %s, trusted by %s", signedBy, signer.Origin)}
		}
		if first == nil {
			first = &reason
		}
	}
	if first != nil {
		return *first
	}
	return Outcome{Code: CodePrincipalUnknown, Detail: fmt.Sprintf("no allowed-signers line names %s with key %s", principal, ssh.FingerprintSHA256(signature.PublicKey))}
}

// holds reports whether the signer's line names key, by the key itself or
// by its pinned fingerprint.
func (s Signer) holds(key ssh.PublicKey) bool {
	if s.Key == nil {
		return s.Fingerprint == ssh.FingerprintSHA256(key)
	}
	return bytes.Equal(s.Key.Marshal(), key.Marshal())
}

func (s Signer) admits(at time.Time) Outcome {
	switch {
	case s.HasNamespaces && !matchList(Namespace, s.Namespaces):
		return Outcome{Code: CodeNamespaceNotPermitted, Detail: fmt.Sprintf("allowed-signers line %d admits namespaces %q only", s.Line, s.Namespaces)}
	case !s.ValidAfter.IsZero() && at.Before(s.ValidAfter):
		return Outcome{Code: CodeNotYetValid, Detail: fmt.Sprintf("allowed-signers line %d is valid after %s, the attestation was made at %s", s.Line, s.ValidAfter.UTC().Format(time.RFC3339), at.UTC().Format(time.RFC3339))}
	case !s.ValidBefore.IsZero() && at.After(s.ValidBefore):
		return Outcome{Code: CodeExpired, Detail: fmt.Sprintf("allowed-signers line %d is valid before %s, the attestation was made at %s", s.Line, s.ValidBefore.UTC().Format(time.RFC3339), at.UTC().Format(time.RFC3339))}
	}
	return Outcome{}
}

// matchList is OpenSSH's match_pattern_list: s matches a comma-separated
// list of patterns when some pattern matches it and no negated one does.
func matchList(s, list string) bool {
	matched := false
	for _, pattern := range strings.Split(list, ",") {
		negated := strings.HasPrefix(pattern, "!")
		if negated {
			pattern = pattern[1:]
		}
		if match(s, pattern) {
			if negated {
				return false
			}
			matched = true
		}
	}
	return matched
}

// match is OpenSSH's match_pattern: * matches any run of characters and ?
// any one.
func match(s, pattern string) bool {
	for pattern != "" {
		switch pattern[0] {
		case '*':
			rest := strings.TrimLeft(pattern, "*")
			if rest == "" {
				return true
			}
			for i := 0; i <= len(s); i++ {
				if match(s[i:], rest) {
					return true
				}
			}
			return false
		case '?':
			if s == "" {
				return false
			}
			s, pattern = s[1:], pattern[1:]
		default:
			if s == "" || s[0] != pattern[0] {
				return false
			}
			s, pattern = s[1:], pattern[1:]
		}
	}
	return s == ""
}
