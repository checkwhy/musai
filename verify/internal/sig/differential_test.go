package sig_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/checkwhy/musai/verify/internal/sig"
)

// TestEveryAllowedSignersRowIsAnsweredAsSSHKeygenAnswersIt runs one
// signature against a table of allowed-signers files through both this
// package and the system OpenSSH, with the verify time the kernel passes:
// the attestation's own time, to the second, in UTC.
func TestEveryAllowedSignersRowIsAnsweredAsSSHKeygenAnswersIt(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is not on PATH: the differential needs the system OpenSSH")
	}
	a, b := newKey(t), newKey(t)
	message := []byte(`{"at":"2026-08-31T12:16:00.376Z","kind":"attestation","principal":"florin"}`)
	signatures := map[string][]byte{"musai": a.sign(t, message, sig.Namespace), "git": a.sign(t, message, "git")}
	rows := []string{
		"florin " + a.line,
		"alice " + a.line,
		"florin " + b.line,
		`"florin" ` + a.line,
		"fl*n " + a.line,
		"fl?rin " + a.line,
		"*,!florin " + a.line,
		"alice,florin " + a.line,
		"FLORIN " + a.line,
		"   florin\t" + a.line + " a comment after the key",
		`florin namespaces="musai" ` + a.line,
		`florin namespaces="git" ` + a.line,
		`florin namespaces="li*" ` + a.line,
		`florin NAMESPACES="musai" ` + a.line,
		`florin namespaces="git,musai" ` + a.line,
		`florin namespaces="git, musai" ` + a.line,
		`florin namespaces=musai ` + a.line,
		`florin namespaces="git",namespaces="musai" ` + a.line,
		`florin valid-after="20260831121600Z" ` + a.line,
		`florin valid-after="20260831121601Z" ` + a.line,
		`florin valid-before="20260831121600Z" ` + a.line,
		`florin valid-before="20260831121559Z" ` + a.line,
		`florin valid-after="20260831" ` + a.line,
		`florin valid-after="20260901" ` + a.line,
		`florin valid-after="202608311216" ` + a.line,
		`florin valid-after="20260831121600UTC" ` + a.line,
		`florin valid-after="20260831121600z" ` + a.line,
		`florin valid-after="2026083112160" ` + a.line,
		`florin valid-after="20261332" ` + a.line,
		`florin valid-after="20260101Z",valid-before="20270101Z",namespaces="musai" ` + a.line,
		`florin cert-authority ` + a.line,
		`florin bogus ` + a.line,
		`florin ` + a.line + "\n# a comment\n",
		"florin ssh-ed25519 notbase64\nflorin " + a.line,
		`florin valid-before="20260101Z" ` + a.line + "\nflorin " + a.line,
		"florin",
		`florin namespaces="musai ` + a.line,
		"",
		`florin namespaces="" ` + a.line,
		`florin namespaces="musai", ` + a.line,
		`florin valid-after="19700101Z" ` + a.line,
		`florin valid-after="19691231Z" ` + a.line,
		`florin valid-after="20260831121600Z",valid-before="20260831121600Z" ` + a.line,
		`florin valid-after="20270101Z",valid-before="20260101Z" ` + a.line,
		`florin namespaces="x\",musai" ` + a.line,
		`florin,"x y" ` + a.line,
		`"florin"` + a.line,
		`fl"or"in ` + a.line,
		`florin valid-before="20270230Z" ` + a.line,
		`florin valid-after="202608311800" ` + a.line,
		`florin valid-after="20260831121660Z" ` + a.line,
		`florin cert-authority,namespaces="musai" ` + a.line,
	}
	dir := t.TempDir()
	messagePath := filepath.Join(dir, "message")
	if err := os.WriteFile(messagePath, message, 0o600); err != nil {
		t.Fatal(err)
	}
	openssh := func(allowedSigners string, signature []byte) (bool, string) {
		t.Helper()
		allowed := filepath.Join(dir, "allowed")
		signaturePath := filepath.Join(dir, "message.sig")
		if err := os.WriteFile(allowed, []byte(allowedSigners+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(signaturePath, signature, 0o600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(keygen, "-Overify-time=20260831121600Z", "-Y", "verify", "-f", allowed, "-I", "florin", "-n", "musai", "-s", signaturePath)
		cmd.Stdin = bytes.NewReader(message)
		cmd.Env = append(os.Environ(), "TZ=UTC")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		return cmd.Run() == nil, stderr.String()
	}
	if ok, stderr := openssh(rows[0], signatures["musai"]); !ok {
		t.Skipf("this ssh-keygen cannot verify the one-line baseline, so it cannot be the oracle: %s", stderr)
	}
	// A time with no zone is local to ssh-keygen and UTC here, so ssh-keygen
	// runs with TZ=UTC: the answer it gives on a machine set to UTC.
	for namespace, signature := range signatures {
		for i, row := range rows {
			verified, stderr := openssh(row, signature)
			parsed, _ := sig.ParseAllowedSigners([]byte(row + "\n"))
			out := sig.Verify(message, signature, "florin", attestedAt, parsed)
			if ours := out.Code == ""; ours != verified {
				t.Errorf("row %d, signed under %s: ssh-keygen verified=%v (%s), this package verified=%v (%s %s)\n%s", i, namespace, verified, stderr, ours, out.Code, out.Detail, row)
			}
		}
	}
}
