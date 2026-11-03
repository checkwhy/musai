package sig_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/sig"
)

// TestEveryAllowedSignersRowIsAnsweredAsSSHKeygenAnswersTheLinesRead runs
// one signature against a table of allowed-signers files through this
// package and through the system OpenSSH, over the whole file and without
// the lines the kernel's rules refuse, at the time the kernel passes: the
// attestation's own, to the second, in UTC. Where ssh-keygen verifies over
// the whole file and this package does not, the row names the refusal.
func TestEveryAllowedSignersRowIsAnsweredAsSSHKeygenAnswersTheLinesRead(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is not on PATH: the differential needs the system OpenSSH")
	}
	a, b := newKey(t), newKey(t)
	message := []byte(`{"at":"2026-08-31T12:16:00.376Z","kind":"attestation","principal":"florin"}`)
	signatures := map[string][]byte{"musai": a.sign(t, message, sig.Namespace), "git": a.sign(t, message, "git")}
	rows := []row{
		{line: "florin " + a.line},
		{line: "alice " + a.line},
		{line: "florin " + b.line},
		{line: `"florin" ` + a.line, stricter: sig.RefusedPrincipalQuoted},
		{line: "fl*n " + a.line, stricter: sig.RefusedPrincipalPattern},
		{line: "fl?rin " + a.line, stricter: sig.RefusedPrincipalPattern},
		{line: "*,!florin " + a.line},
		{line: "alice,florin " + a.line},
		{line: "FLORIN " + a.line},
		{line: "   florin\t" + a.line + " a comment after the key"},
		{line: `florin namespaces="musai" ` + a.line},
		{line: `florin namespaces="git" ` + a.line},
		{line: `florin namespaces="li*" ` + a.line},
		{line: `florin NAMESPACES="musai" ` + a.line},
		{line: `florin namespaces="git,musai" ` + a.line},
		{line: `florin namespaces="git, musai" ` + a.line},
		{line: `florin namespaces=musai ` + a.line},
		{line: `florin namespaces="git",namespaces="musai" ` + a.line},
		{line: `florin valid-after="20260831121600Z" ` + a.line},
		{line: `florin valid-after="20260831121601Z" ` + a.line},
		{line: `florin valid-before="20260831121600Z" ` + a.line},
		{line: `florin valid-before="20260831121559Z" ` + a.line},
		{line: `florin valid-after="20260831" ` + a.line, stricter: sig.RefusedTime},
		{line: `florin valid-after="20260901" ` + a.line},
		{line: `florin valid-after="202608311216" ` + a.line, stricter: sig.RefusedTime},
		{line: `florin valid-after="20260831121600UTC" ` + a.line},
		{line: `florin valid-after="20260831121600z" ` + a.line},
		{line: `florin valid-after="2026083112160" ` + a.line},
		{line: `florin valid-after="20261332" ` + a.line},
		{line: `florin valid-after="20260101Z",valid-before="20270101Z",namespaces="musai" ` + a.line},
		{line: `florin cert-authority ` + a.line},
		{line: `florin bogus ` + a.line},
		{line: `florin ` + a.line + "\n# a comment\n"},
		{line: "florin ssh-ed25519 notbase64\nflorin " + a.line},
		{line: `florin valid-before="20260101Z" ` + a.line + "\nflorin " + a.line},
		{line: "florin"},
		{line: `florin namespaces="musai ` + a.line},
		{line: ""},
		{line: `florin namespaces="" ` + a.line},
		{line: `florin namespaces="musai", ` + a.line},
		{line: `florin valid-after="19700101Z" ` + a.line},
		{line: `florin valid-after="19691231Z" ` + a.line},
		{line: `florin valid-after="20260831121600Z",valid-before="20260831121600Z" ` + a.line},
		{line: `florin valid-after="20270101Z",valid-before="20260101Z" ` + a.line},
		{line: `florin namespaces="x\",musai" ` + a.line, stricter: sig.RefusedIncomplete},
		{line: `florin,"x y" ` + a.line, stricter: sig.RefusedUnreadCharacter},
		{line: `"florin"` + a.line, stricter: sig.RefusedIncomplete},
		{line: `fl"or"in ` + a.line},
		{line: `florin valid-before="20270230Z" ` + a.line},
		{line: `florin valid-after="202608311800" ` + a.line},
		{line: `florin valid-after="20260831121660Z" ` + a.line},
		{line: `florin cert-authority,namespaces="musai" ` + a.line},
		{line: `florin valid-after="19700101000001Z" ` + a.line},
		{line: `florin valid-after="20270231Z",valid-before="20270302Z" ` + a.line},
		{line: `florin namespaces="musai\" ` + a.line},
		{line: `florin namespaceſ="musai" ` + a.line},
		{line: `florin,key:SHA256:nope ` + a.line, stricter: sig.RefusedKeyForeign},
		{line: "florin,\u00a0alice " + a.line, stricter: sig.RefusedUnreadCharacter},
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
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		return cmd.Run() == nil, stderr.String()
	}
	if ok, stderr := openssh(rows[0].line, signatures["musai"]); !ok {
		t.Skipf("this ssh-keygen cannot verify the one-line baseline, so it cannot be the oracle: %s", stderr)
	}
	for namespace, signature := range signatures {
		for i, row := range rows {
			parsed, problems := sig.ParseAllowedSigners([]byte(row.line + "\n"))
			read, stderr := openssh(readLines(row.line, problems), signature)
			whole, _ := openssh(row.line, signature)
			out := sig.Verify(message, signature, "florin", attestedAt, parsed)
			ours := out.Code == ""
			if ours != read {
				t.Errorf("row %d, signed under %s: ssh-keygen verified=%v (%s) over the lines read, this package verified=%v (%s %s), refusing %v\n%s", i, namespace, read, stderr, ours, out.Code, out.Detail, problems, row.line)
			}
			stricter := whole && !ours
			if stricter != (row.stricter != "" && namespace == sig.Namespace) || (stricter && !refusedAs(problems, row.stricter)) {
				t.Errorf("row %d, signed under %s: ssh-keygen verified=%v over the whole file, this package verified=%v refusing %v, and the row says the kernel refuses what ssh-keygen reads as %q\n%s", i, namespace, whole, ours, problems, row.stricter, row.line)
			}
		}
	}
}

// row is an allowed-signers file, and the class of the refusal by which the
// kernel's rules verify nothing where ssh-keygen verifies over the whole file.
type row struct {
	line     string
	stricter string
}

func refusedAs(problems []sig.LineError, class string) bool {
	for _, problem := range problems {
		if problem.Class == class {
			return true
		}
	}
	return false
}

// readLines is a file without the lines refused in it.
func readLines(file string, refused []sig.LineError) string {
	lines := strings.Split(file, "\n")
	for _, problem := range refused {
		lines[problem.Line-1] = ""
	}
	return strings.Join(lines, "\n")
}
