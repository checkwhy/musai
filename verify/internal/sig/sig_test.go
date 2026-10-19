package sig_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hiddeco/sshsig"
	"golang.org/x/crypto/ssh"

	"github.com/checkwhy/musai/verify/internal/sig"
)

const (
	fixture         = "../../../conformance/bundles/passing"
	attestationPath = "records/attestation/42/eb/42eb14cc43763a1d89f80dd81def025b9bda99a2e7b4d0b128d06569ba365b28.json"
)

var attestedAt = time.Date(2026, 8, 31, 12, 16, 0, 376_000_000, time.UTC)

func read(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixture, path))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func signers(t *testing.T, text string) []sig.Signer {
	t.Helper()
	parsed, problems := sig.ParseAllowedSigners([]byte(text))
	if len(problems) > 0 {
		t.Logf("lines skipped: %v", problems)
	}
	return parsed
}

func TestTheFixturesSignatureVerifiesUnderItsAllowedSigners(t *testing.T) {
	out := sig.Verify(read(t, attestationPath), read(t, attestationPath+".sig"), "florin", attestedAt, signers(t, string(read(t, "allowed-signers"))))
	if out.Code != "" {
		t.Fatalf("%s: %s", out.Code, out.Detail)
	}
}

func TestATamperedMessageIsABadSignature(t *testing.T) {
	message := bytes.Replace(read(t, attestationPath), []byte("florin"), []byte("florim"), 1)
	out := sig.Verify(message, read(t, attestationPath+".sig"), "florin", attestedAt, signers(t, string(read(t, "allowed-signers"))))
	if out.Code != sig.CodeBad {
		t.Fatalf("code %q, want %s", out.Code, sig.CodeBad)
	}
}

func TestNotArmoredIsMalformed(t *testing.T) {
	out := sig.Verify(read(t, attestationPath), []byte("-----BEGIN SSH SIGNATURE-----\nnope\n"), "florin", attestedAt, nil)
	if out.Code != sig.CodeMalformed {
		t.Fatalf("code %q, want %s", out.Code, sig.CodeMalformed)
	}
}

type key struct {
	signer ssh.Signer
	line   string
}

func newKey(t *testing.T) key {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return key{signer: signer, line: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))}
}

func (k key) sign(t *testing.T, message []byte, namespace string) []byte {
	t.Helper()
	signature, err := sshsig.Sign(bytes.NewReader(message), k.signer, sshsig.HashSHA512, namespace)
	if err != nil {
		t.Fatal(err)
	}
	return sshsig.Armor(signature)
}

func TestTheOutcomeOfEachSignerCheck(t *testing.T) {
	a, b := newKey(t), newKey(t)
	message := []byte(`{"kind":"attestation"}`)
	good := a.sign(t, message, sig.Namespace)
	cases := []struct {
		name      string
		signature []byte
		allowed   string
		want      string
	}{
		{"a listed key verifies", good, "florin " + a.line, ""},
		{"another namespace", a.sign(t, message, "git"), "florin " + a.line, sig.CodeNamespace},
		{"principal absent", good, "alice " + a.line, sig.CodePrincipalUnknown},
		{"key absent", good, "florin " + b.line, sig.CodePrincipalUnknown},
		{"namespace not permitted", good, `florin namespaces="git" ` + a.line, sig.CodeNamespaceNotPermitted},
		{"not yet valid", good, `florin valid-after="20260831121601Z" ` + a.line, sig.CodeNotYetValid},
		{"expired", good, `florin valid-before="20260831121559Z" ` + a.line, sig.CodeExpired},
		{"a later line verifies after an earlier fails", good, `florin valid-before="20260101Z" ` + a.line + "\nflorin " + a.line, ""},
	}
	for _, c := range cases {
		out := sig.Verify(message, c.signature, "florin", attestedAt, signers(t, c.allowed))
		if out.Code != c.want {
			t.Errorf("%s: code %q (%s), want %q", c.name, out.Code, out.Detail, c.want)
		}
	}
}

func TestAMalformedLineIsReportedAndSkipped(t *testing.T) {
	a := newKey(t)
	parsed, problems := sig.ParseAllowedSigners([]byte("# comment\n\nflorin namespaces=musai " + a.line + "\nflorin " + a.line + "\n"))
	if len(parsed) != 1 || parsed[0].Line != 4 {
		t.Fatalf("parsed %+v, want only line 4", parsed)
	}
	if len(problems) != 1 || problems[0].Line != 3 {
		t.Fatalf("problems %+v, want line 3", problems)
	}
}

// A day or month of 00 is refused, as glibc's strptime refuses it; BSD
// libc's normalises it to the day before, so ssh-keygen itself answers
// differently on macOS, and the differential leaves the row out.
func TestADayOfZeroIsNotATime(t *testing.T) {
	a := newKey(t)
	for _, when := range []string{"20260800Z", "20260031Z"} {
		parsed, problems := sig.ParseAllowedSigners([]byte(`florin valid-after="` + when + `" ` + a.line))
		if len(parsed) != 0 || len(problems) != 1 {
			t.Errorf("%s: parsed %d lines, %d problems; want the line refused", when, len(parsed), len(problems))
		}
	}
}

// A time with no zone is read as UTC wherever the verifier runs, so one
// bundle gets one verdict on every machine; ssh-keygen reads it in its own
// local time, and the line is marked so a verifier can say so.
func TestATimeWithoutAZoneIsReadAsUTCAndMarked(t *testing.T) {
	a := newKey(t)
	for when, zoneless := range map[string]bool{"20260831": true, "202608311200": true, "20260831Z": false, "20260831120000UTC": false} {
		parsed, problems := sig.ParseAllowedSigners([]byte(`florin valid-after="` + when + `" ` + a.line))
		if len(parsed) != 1 || len(problems) != 0 {
			t.Fatalf("%s: parsed %d, problems %v", when, len(parsed), problems)
		}
		if parsed[0].ValidAfter.Location() != time.UTC || parsed[0].Zoneless != zoneless {
			t.Errorf("%s: at %v, zoneless %v; want UTC and %v", when, parsed[0].ValidAfter, parsed[0].Zoneless, zoneless)
		}
	}
}

func TestAPinnedFingerprintMatchesOnlyItsKey(t *testing.T) {
	message, signature := read(t, attestationPath), read(t, attestationPath+".sig")
	pinned := []sig.Signer{{Principals: "florin", Fingerprint: "SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"}}
	if out := sig.Verify(message, signature, "florin", attestedAt, pinned); out.Code != "" {
		t.Fatalf("the fixture's own key pinned: %s %s", out.Code, out.Detail)
	}
	other := []sig.Signer{{Principals: "florin", Fingerprint: "SHA256:AAAAbtFxkELD0ccc0cxDBE87gG2aE/Yyt+W01EOwKpI"}}
	if out := sig.Verify(message, signature, "florin", attestedAt, other); out.Code != sig.CodePrincipalUnknown {
		t.Fatalf("another key pinned: code %q", out.Code)
	}
	elsewhere := []sig.Signer{{Principals: "alice", Fingerprint: pinned[0].Fingerprint}}
	if out := sig.Verify(message, signature, "florin", attestedAt, elsewhere); out.Code != sig.CodePrincipalUnknown {
		t.Fatalf("the key pinned for another principal: code %q", out.Code)
	}
}

func TestAVerifiedSignatureNamesWhereItsKeyWasTrusted(t *testing.T) {
	message, signature := read(t, attestationPath), read(t, attestationPath+".sig")
	pinned := []sig.Signer{{Principals: "florin", Fingerprint: "SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY", Origin: "florin's pinned key"}}
	out := sig.Verify(message, signature, "florin", attestedAt, pinned)
	if out.Code != "" || !strings.Contains(out.Detail, "florin's pinned key") || strings.Contains(out.Detail, "line 0") {
		t.Fatalf("detail %q", out.Detail)
	}
	parsed := signers(t, string(read(t, "allowed-signers")))
	if out := sig.Verify(message, signature, "florin", attestedAt, parsed); !strings.Contains(out.Detail, "allowed-signers line 1") {
		t.Fatalf("detail %q", out.Detail)
	}
}

func TestASignerNamedByKeyIsShownWithTheNameItsLineListsBesideIt(t *testing.T) {
	message, signature := read(t, attestationPath), read(t, attestationPath+".sig")
	const key = "key:SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"
	line := strings.Replace(string(read(t, "allowed-signers")), "florin ", "florin,"+key+" ", 1)
	out := sig.Verify(message, signature, key, attestedAt, signers(t, line))
	if out.Code != "" || !strings.HasPrefix(out.Detail, "signed by florin ("+key+"), trusted by") {
		t.Fatalf("%s: %q", out.Code, out.Detail)
	}
}
