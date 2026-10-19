// Package trust resolves whose keys a verification checks signatures
// against. By default that is the source's own allowed-signers, which a
// bundle's sender chose; a receiver names keys they chose themselves with
// --trust: a GitHub account's published keys, a pinned key fingerprint, a
// directory holding an allowed-signers file, or a workspace's trust branch
// at another commit.
package trust

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing/fstest"

	"github.com/checkwhy/musai/verify/internal/sig"
	"github.com/checkwhy/musai/verify/internal/source"
)

// ErrSpec refuses a trust source that is not one: the invocation to fix.
var ErrSpec = errors.New("not a trust source")

// ErrNotFound is what a Fetch answers for a URL with nothing behind it.
var ErrNotFound = errors.New("not found")

// Fetch reads the body at an HTTPS URL, answering ErrNotFound for a 404.
type Fetch func(url string) ([]byte, error)

// Substrate names a trust source in a report's recipe.
type Substrate struct {
	Name        string
	URI         string
	Digest      map[string]string
	Annotations map[string]string
}

// Anchor is one source of trusted keys.
type Anchor struct {
	// Description says, for a person reading a verdict, whose keys these are.
	Description string
	Signers     []sig.Signer
	// Problems are the lines of an allowed-signers file ssh-keygen would skip.
	Problems []sig.LineError
	// ReadErr is an allowed-signers file present but unreadable.
	ReadErr error
	// Path names the file an anchor's problems are in.
	Path string
	// Argument re-creates the anchor on a command line, as a recipe does:
	// the spec for a portable one, its substrate's name for a local directory.
	Argument string
	// Substrate names the anchor in a report; nil for the source's own trust.
	Substrate *Substrate
}

// Set is every anchor a verification trusts.
type Set []Anchor

// Signers is every anchor's signers.
func (s Set) Signers() []sig.Signer {
	var all []sig.Signer
	for _, anchor := range s {
		all = append(all, anchor.Signers...)
	}
	return all
}

// Describe names every anchor, in order, for a person reading a verdict.
func (s Set) Describe() string {
	descriptions := make([]string, len(s))
	for i, anchor := range s {
		descriptions[i] = anchor.Description
	}
	return strings.Join(descriptions, "; ")
}

// With is the set and one more anchor, every anchor's substrate named
// apart from the others' as Resolve names them, leaving the set itself as
// it was. Every anchor in it names a substrate: only the source's own
// trust names none, and that is never combined with another.
func (s Set) With(anchor Anchor) Set {
	set := append(slices.Clone(s), anchor)
	if len(set) > 1 {
		for i := range set {
			substrate := *set[i].Substrate
			set[i].Substrate = &substrate
			rename(&set[i], "trust-"+strconv.Itoa(i+1))
		}
	}
	return set
}

// FromText is an allowed-signers file a receiver gave as text rather than
// as a directory, as a page takes it. It is named in a report exactly as a
// directory holding only that file would be, so the recipe re-runs with
// the text saved as trust/allowed-signers.
func FromText(text []byte) (Anchor, error) {
	fsys := fstest.MapFS{"allowed-signers": &fstest.MapFile{Data: text}}
	digest, err := source.Digest(fsys)
	if err != nil {
		return Anchor{}, err
	}
	anchor := fromFile(fsys, "trust/allowed-signers")
	anchor.Description = "the allowed-signers you gave"
	anchor.Argument = "trust"
	anchor.Substrate = &Substrate{Name: "trust", Digest: map[string]string{"sha256": digest}}
	return anchor, nil
}

// Own is the source's own allowed-signers.
func Own(src *source.Source) Set {
	anchor := fromFile(src.Trust, "allowed-signers")
	anchor.Description = src.TrustedBy
	return Set{anchor}
}

func fromFile(fsys fs.FS, path string) Anchor {
	anchor := Anchor{Path: path}
	data, err := fs.ReadFile(fsys, "allowed-signers")
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		anchor.ReadErr = err
	default:
		anchor.Signers, anchor.Problems = sig.ParseAllowedSigners(data)
	}
	return anchor
}

// Resolve reads each spec, in order. A spec that names nothing trustable
// is ErrSpec; a fetch that fails for any reason but a missing page is
// returned as it failed.
func Resolve(specs []string, src *source.Source, fetch Fetch) (Set, error) {
	set := make(Set, 0, len(specs))
	for _, spec := range specs {
		anchor, err := resolve(spec, src, fetch)
		if err != nil {
			return nil, err
		}
		set = append(set, anchor)
	}
	if len(set) > 1 {
		for i := range set {
			rename(&set[i], "trust-"+strconv.Itoa(i+1))
		}
	}
	return set, nil
}

// rename gives an anchor's substrate a name unique in the set, keeping a
// directory's argument and the path its findings name the substrate's name
// it is bound by.
func rename(anchor *Anchor, name string) {
	if anchor.Argument == anchor.Substrate.Name {
		anchor.Argument, anchor.Path = name, name+"/allowed-signers"
	}
	anchor.Substrate.Name = name
}

var (
	// principalPattern admits a literal principal: nothing allowed-signers
	// would read as a pattern, a list or a quote.
	principalPattern = regexp.MustCompile(`^[^\s=*?!,"\x00-\x1f\x7f]+$`)
	githubUser       = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
)

func resolve(spec string, src *source.Source, fetch Fetch) (Anchor, error) {
	if principal, rest, pinned := strings.Cut(spec, "="); pinned {
		if !principalPattern.MatchString(principal) {
			return Anchor{}, fmt.Errorf("%q: the principal before = must be one literal name, with no space, quote, comma or * ? !: %w", spec, ErrSpec)
		}
		switch {
		case strings.HasPrefix(rest, "github:"):
			return fromGitHub(spec, principal, strings.TrimPrefix(rest, "github:"), fetch)
		case strings.HasPrefix(rest, "SHA256:"):
			return fromFingerprint(spec, principal, rest)
		}
		return Anchor{}, fmt.Errorf("%q: after <principal>= comes github:<user> or SHA256:<fingerprint>: %w", spec, ErrSpec)
	}
	if info, err := os.Stat(spec); err == nil && info.IsDir() {
		if _, commit, err := src.TrustAt(spec); err == nil {
			return Anchor{}, fmt.Errorf("%q is both a directory here and the workspace's commit %s: name the directory as ./%s or give the commit's hash: %w", spec, commit, spec, ErrSpec)
		}
		return fromDirectory(spec, src)
	}
	if strings.HasPrefix(spec, "github:") {
		return Anchor{}, fmt.Errorf("%q names no principal: write <principal>=%s: %w", spec, spec, ErrSpec)
	}
	return fromCommit(spec, src)
}

func fromGitHub(spec, principal, user string, fetch Fetch) (Anchor, error) {
	if !githubUser.MatchString(user) {
		return Anchor{}, fmt.Errorf("%q: %q is not a GitHub account name: %w", spec, user, ErrSpec)
	}
	url := "https://github.com/" + user + ".keys"
	body, err := fetch(url)
	switch {
	case errors.Is(err, ErrNotFound):
		return Anchor{}, fmt.Errorf("%q: GitHub has no account %s: %w", spec, user, ErrSpec)
	case err != nil:
		return Anchor{}, fmt.Errorf("reading %s: %w", url, err)
	}
	var signers []sig.Signer
	var problems []sig.LineError
	lines := 0
	for i, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lines++
		key, err := sig.ParseKey(line)
		if err != nil {
			problems = append(problems, sig.LineError{Line: i + 1, Reason: "not a key: " + err.Error()})
			continue
		}
		// A record names its signer by key, so a trusted key speaks under its own form too.
		owned := principal + "," + sig.Signer{Key: key}.OwnKeyForm()
		signers = append(signers, sig.Signer{Principals: owned, Key: key, Origin: fmt.Sprintf("key %d of github.com/%s.keys", len(signers)+1, user)})
	}
	switch {
	case lines == 0:
		return Anchor{}, fmt.Errorf("%q: the GitHub account %s publishes no SSH key: %w", spec, user, ErrSpec)
	case len(signers) == 0:
		return Anchor{}, fmt.Errorf("%s answered with no SSH key line, which is not how GitHub answers: is something between here and GitHub?", url)
	}
	sum := sha256.Sum256(body)
	return Anchor{
		Description: fmt.Sprintf("%s's keys on GitHub (github.com/%s.keys, %d %s)", principal, user, len(signers), plural(len(signers), "key")),
		Signers:     signers,
		Problems:    problems,
		Path:        url,
		Argument:    spec,
		Substrate: &Substrate{
			Name: "trust", URI: url,
			Digest:      map[string]string{"sha256": hex.EncodeToString(sum[:])},
			Annotations: map[string]string{"principal": principal},
		},
	}, nil
}

func fromFingerprint(spec, principal, fingerprint string) (Anchor, error) {
	encoded := strings.TrimPrefix(fingerprint, "SHA256:")
	digest, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(digest) != sha256.Size || base64.RawStdEncoding.EncodeToString(digest) != encoded {
		return Anchor{}, fmt.Errorf("%q: %q is not an SSH SHA256 fingerprint: %w", spec, fingerprint, ErrSpec)
	}
	return Anchor{
		Description: fmt.Sprintf("%s's key %s, pinned", principal, fingerprint),
		Signers:     []sig.Signer{{Principals: principal + "," + sig.KeyPrefix + fingerprint, Fingerprint: fingerprint, Origin: principal + "'s pinned key " + fingerprint}},
		Argument:    spec,
		Substrate: &Substrate{
			Name:        "trust",
			Digest:      map[string]string{"sha256": hex.EncodeToString(digest)},
			Annotations: map[string]string{"principal": principal, "fingerprint": fingerprint},
		},
	}, nil
}

func fromDirectory(dir string, src *source.Source) (Anchor, error) {
	if inside(dir, src.Name) {
		return Anchor{}, fmt.Errorf("%s lies inside the source, where its sender could have put it: %w", dir, ErrSpec)
	}
	fsys := os.DirFS(dir)
	if _, err := fs.Stat(fsys, "allowed-signers"); err != nil {
		return Anchor{}, fmt.Errorf("%s holds no allowed-signers file: %w", dir, ErrSpec)
	}
	digest, err := source.Digest(fsys)
	if err != nil {
		return Anchor{}, err
	}
	anchor := fromFile(fsys, "trust/allowed-signers")
	anchor.Description = "the allowed-signers in " + dir
	anchor.Argument = "trust"
	anchor.Substrate = &Substrate{Name: "trust", Digest: map[string]string{"sha256": digest}}
	return anchor, nil
}

// inside reports whether dir is the source's directory or lies under it.
func inside(dir, sourcePath string) bool {
	base, err := filepath.Abs(sourcePath)
	if err != nil {
		return false
	}
	target, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(base, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func fromCommit(name string, src *source.Source) (Anchor, error) {
	fsys, commit, err := src.TrustAt(name)
	if err != nil {
		return Anchor{}, fmt.Errorf("%q is not a directory, a pin or a commit of this workspace (%w): %w", name, err, ErrSpec)
	}
	anchor := fromFile(fsys, commit+":allowed-signers")
	anchor.Description = "the allowed-signers at " + name + " (" + commit + ")"
	anchor.Argument = commit
	anchor.Substrate = &Substrate{Name: "trust", Digest: map[string]string{"gitCommit": commit}}
	return anchor, nil
}

func plural(n int, noun string) string {
	if n == 1 {
		return noun
	}
	return noun + "s"
}
