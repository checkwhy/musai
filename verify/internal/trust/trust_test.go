package trust_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
	"github.com/checkwhy/musai/verify/internal/workspacetest"
)

const (
	passing   = "../../../conformance/bundles/passing"
	florinKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5"
	otherKey  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElYQ6ImuiDBa6H5Mb8Jz/JUMDjpnS+QGvT6RKOP4jjl"
)

func workspace(t *testing.T) string {
	t.Helper()
	return filepath.Join(workspacetest.New(t), ".musai")
}

func open(t *testing.T, path string) *source.Source {
	t.Helper()
	src, err := source.Open(path, source.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return src
}

// github answers as github.com does for the accounts it knows.
func github(accounts map[string]string) trust.Fetch {
	return func(url string) ([]byte, error) {
		for user, keys := range accounts {
			if url == "https://github.com/"+user+".keys" {
				return []byte(keys), nil
			}
		}
		return nil, trust.ErrNotFound
	}
}

func TestAGitHubAccountsPublishedKeysAreTrustedForItsPrincipalAndEachKeysOwnForm(t *testing.T) {
	set, err := trust.Resolve([]string{"florin=github:florinutz"}, open(t, passing), github(map[string]string{"florinutz": florinKey + "\n" + otherKey + "\n"}))
	if err != nil {
		t.Fatal(err)
	}
	anchor := set[0]
	if len(anchor.Signers) != 2 || anchor.Signers[0].Principals != "florin,key:SHA256:xINMbtFxkELD0ccc0cxDBE87gG2aE/Yyt+W01EOwKpI" {
		t.Fatalf("signers %+v", anchor.Signers)
	}
	if anchor.Argument != "florin=github:florinutz" || anchor.Substrate.URI != "https://github.com/florinutz.keys" || len(anchor.Substrate.Digest["sha256"]) != 64 {
		t.Fatalf("anchor %+v, substrate %+v", anchor, anchor.Substrate)
	}
	if !strings.Contains(anchor.Description, "github.com/florinutz.keys") {
		t.Fatalf("description %q", anchor.Description)
	}
}

func TestAGitHubAccountThatDoesNotExistOrHoldsNoKeysIsAnInvocationToFix(t *testing.T) {
	fetch := github(map[string]string{"keyless": "\n"})
	for _, spec := range []string{"florin=github:nobody", "florin=github:keyless"} {
		if _, err := trust.Resolve([]string{spec}, open(t, passing), fetch); !errors.Is(err, trust.ErrSpec) {
			t.Errorf("%s: err %v, want ErrSpec", spec, err)
		}
	}
}

func TestGitHubBeingUnreachableIsTheVerifierFailingNotTheInvocation(t *testing.T) {
	down := errors.New("dial tcp: connection refused")
	_, err := trust.Resolve([]string{"florin=github:florinutz"}, open(t, passing), func(string) ([]byte, error) { return nil, down })
	if !errors.Is(err, down) || errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v", err)
	}
}

func TestAPinnedFingerprintIsTrustedForItsPrincipalAndItsKeysOwnForm(t *testing.T) {
	set, err := trust.Resolve([]string{"florin=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"}, open(t, passing), github(nil))
	if err != nil {
		t.Fatal(err)
	}
	anchor := set[0]
	if len(anchor.Signers) != 1 || anchor.Signers[0].Fingerprint != "SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY" || anchor.Signers[0].Principals != "florin,key:SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY" {
		t.Fatalf("signers %+v", anchor.Signers)
	}
	if anchor.Argument != "florin=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY" || len(anchor.Substrate.Digest["sha256"]) != 64 {
		t.Fatalf("anchor %+v", anchor)
	}
}

func TestAMistypedSpecIsAnInvocationToFix(t *testing.T) {
	for _, spec := range []string{
		"florin=github:", "=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY", "github:florinutz",
		"florin=SHA256:not-base64", "florin=SHA256:AAAA", "florin=ftp:florinutz", "flo rin=github:florinutz",
		"florin=github:-leading-dash", filepath.Join(t.TempDir(), "missing"),
	} {
		if _, err := trust.Resolve([]string{spec}, open(t, passing), github(nil)); !errors.Is(err, trust.ErrSpec) {
			t.Errorf("%q: err %v, want ErrSpec", spec, err)
		}
	}
}

func TestADirectoryWithoutAllowedSignersIsNotATrustSource(t *testing.T) {
	if _, err := trust.Resolve([]string{t.TempDir()}, open(t, passing), github(nil)); !errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v, want ErrSpec", err)
	}
}

func TestADirectoryIsNamedInTheRecipeByItsSubstrate(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	for _, dir := range []string{a, b} {
		if err := os.WriteFile(filepath.Join(dir, "allowed-signers"), []byte("florin "+florinKey+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	set, err := trust.Resolve([]string{a, "florin=github:florinutz", b}, open(t, passing), github(map[string]string{"florinutz": florinKey}))
	if err != nil {
		t.Fatal(err)
	}
	if set[0].Argument != set[0].Substrate.Name || set[2].Argument != set[2].Substrate.Name || set[0].Substrate.Name == set[2].Substrate.Name {
		t.Fatalf("anchors %+v %+v", set[0].Substrate, set[2].Substrate)
	}
	if set[0].Argument == a {
		t.Fatal("a local path entered the recipe")
	}
}

func TestAWorkspaceCommitIsATrustSourceOnlyForAWorkspace(t *testing.T) {
	set, err := trust.Resolve([]string{"main"}, open(t, workspace(t)), github(nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(set[0].Argument) != 40 || set[0].Substrate.Digest["gitCommit"] != set[0].Argument {
		t.Fatalf("anchor %+v", set[0])
	}
	if _, err := trust.Resolve([]string{"main"}, open(t, passing), github(nil)); !errors.Is(err, trust.ErrSpec) {
		t.Fatalf("a bundle's commit: err %v", err)
	}
}

func TestWithoutASpecTheSourcesOwnAllowedSignersAreTrusted(t *testing.T) {
	src := open(t, passing)
	set := trust.Own(src)
	if len(set) != 1 || set[0].Substrate != nil || len(set[0].Signers) != 1 || set[0].Description != src.TrustedBy {
		t.Fatalf("set %+v", set)
	}
}

func TestAPrincipalIsALiteralNeverAPattern(t *testing.T) {
	for _, principal := range []string{"*", "flo*", "fl?rin", "!alice", "x,florin", `"florin"`, "a\"b"} {
		for _, form := range []string{"=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY", "=github:florinutz"} {
			spec := principal + form
			if _, err := trust.Resolve([]string{spec}, open(t, passing), github(map[string]string{"florinutz": florinKey})); !errors.Is(err, trust.ErrSpec) {
				t.Errorf("%q: err %v, want ErrSpec", spec, err)
			}
		}
	}
}

func TestAFingerprintMustBeSpelledAsSSHKeygenSpellsIt(t *testing.T) {
	for _, fingerprint := range []string{"SHA256:xINMbtFxkELD0ccc0cxDBE87gG2aE/Yyt+W01EOwKpJ", "SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY=", "SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY\n"} {
		if _, err := trust.Resolve([]string{"florin=" + fingerprint}, open(t, passing), github(nil)); !errors.Is(err, trust.ErrSpec) {
			t.Errorf("%q: err %v, want ErrSpec", fingerprint, err)
		}
	}
}

func TestAGitHubBodyThatIsNoKeyListIsNotBlamedOnTheInvocation(t *testing.T) {
	portal := github(map[string]string{"florinutz": "<html><body>Sign in to the network</body></html>\n"})
	_, err := trust.Resolve([]string{"florin=github:florinutz"}, open(t, passing), portal)
	if err == nil || errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v, want a failure that is not ErrSpec", err)
	}
}

func TestAGitHubLineCarryingOptionsIsNotAKey(t *testing.T) {
	body := `cert-authority ` + florinKey + "\n" + otherKey + "\n"
	set, err := trust.Resolve([]string{"florin=github:florinutz"}, open(t, passing), github(map[string]string{"florinutz": body}))
	if err != nil {
		t.Fatal(err)
	}
	if len(set[0].Signers) != 1 || set[0].Signers[0].CertAuthority {
		t.Fatalf("signers %+v", set[0].Signers)
	}
}

func TestAnAnchorsFindingsNameItAsTheRecipeDoesNeverByALocalPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "allowed-signers"), []byte("florin "+florinKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	set, err := trust.Resolve([]string{dir, "main"}, open(t, workspace(t)), github(nil))
	if err != nil {
		t.Fatal(err)
	}
	for _, anchor := range set {
		if strings.Contains(anchor.Path, dir) || strings.Contains(anchor.Path, "main") || !strings.HasPrefix(anchor.Path, anchor.Argument) {
			t.Errorf("anchor path %q, argument %q", anchor.Path, anchor.Argument)
		}
	}
}

func TestATrustDirectoryInsideTheSourceIsRefused(t *testing.T) {
	bundle := t.TempDir()
	if err := os.CopyFS(bundle, os.DirFS(passing)); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(bundle, "trust")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "allowed-signers"), []byte("florin "+florinKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Resolve([]string{inside}, open(t, bundle), github(nil)); !errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v, want ErrSpec", err)
	}
}

func TestANameThatIsBothADirectoryAndACommitIsRefused(t *testing.T) {
	ws := workspace(t)
	t.Chdir(t.TempDir())
	if err := os.MkdirAll("main", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("main", "allowed-signers"), []byte("florin "+florinKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Resolve([]string{"main"}, open(t, ws), github(nil)); !errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v, want ErrSpec", err)
	}
}

func TestAWorkspaceBranchThatDoesNotExistIsNotATrustSource(t *testing.T) {
	if _, err := trust.Resolve([]string{"no-such-branch"}, open(t, workspace(t)), github(nil)); !errors.Is(err, trust.ErrSpec) {
		t.Fatalf("err %v, want ErrSpec", err)
	}
}

func TestPastedAllowedSignersAreNamedAsADirectoryHoldingThemWouldBe(t *testing.T) {
	text := []byte("florin " + florinKey + "\n")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "allowed-signers"), text, 0o600); err != nil {
		t.Fatal(err)
	}
	fromDirectory, err := trust.Resolve([]string{dir}, open(t, passing), github(nil))
	if err != nil {
		t.Fatal(err)
	}
	pasted, err := trust.FromText(text)
	if err != nil {
		t.Fatal(err)
	}
	if pasted.Substrate.Digest["sha256"] != fromDirectory[0].Substrate.Digest["sha256"] {
		t.Fatalf("pasted text digests to %v, the directory holding it to %v", pasted.Substrate.Digest, fromDirectory[0].Substrate.Digest)
	}
	if len(pasted.Signers) != 1 || pasted.Argument != pasted.Substrate.Name || pasted.Path != "trust/allowed-signers" {
		t.Fatalf("anchor %+v", pasted)
	}
}

func TestAnAnchorAddedToASetIsNamedApartFromTheOthers(t *testing.T) {
	set, err := trust.Resolve([]string{"florin=SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY"}, open(t, passing), github(nil))
	if err != nil {
		t.Fatal(err)
	}
	pasted, err := trust.FromText([]byte("florin " + florinKey + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	with := set.With(pasted)
	if len(set) != 1 || len(with) != 2 {
		t.Fatalf("set %d anchors, with %d", len(set), len(with))
	}
	if with[0].Substrate.Name == with[1].Substrate.Name || with[1].Argument != with[1].Substrate.Name {
		t.Fatalf("anchors named %q and %q, the second's argument %q", with[0].Substrate.Name, with[1].Substrate.Name, with[1].Argument)
	}
	if set[0].Substrate.Name != "trust" {
		t.Fatalf("adding to a set renamed the set's own anchor to %q", set[0].Substrate.Name)
	}
}

func TestASetDescribesEveryAnchorInOrder(t *testing.T) {
	set := trust.Set{{Description: "one"}, {Description: "two"}}
	if got := set.Describe(); got != "one; two" {
		t.Fatalf("described as %q", got)
	}
}
