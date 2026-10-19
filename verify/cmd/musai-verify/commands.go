package main

import (
	"encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"time"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/conformance"
	"github.com/checkwhy/musai/verify/internal/printable"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/report"
	"github.com/checkwhy/musai/verify/internal/sig"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trace"
	"github.com/checkwhy/musai/verify/internal/trust"
)

type sourceFlags struct {
	Scope string   `help:"The scope a workspace is read at." default:"default"`
	Trust []string `help:"Check signatures against keys you chose instead of the source's own allowed-signers: <principal>=github:<user> for a GitHub account's published keys, <principal>=SHA256:<fingerprint> for one pinned key, a directory holding allowed-signers, or a branch or commit of the workspace. Repeat to trust several." sep:"none"`
}

// open reads the source and resolves what its signatures are checked
// against: the keys --trust names, else the source's own allowed-signers.
func (f sourceFlags) open(path string) (*source.Source, trust.Set, error) {
	src, err := source.Open(path, source.Options{Scope: f.Scope})
	if err != nil {
		return nil, nil, err
	}
	if len(f.Trust) == 0 {
		return src, trust.Own(src), nil
	}
	set, err := trust.Resolve(f.Trust, src, httpsFetch(githubClient()))
	return src, set, err
}

// githubClient is the client a GitHub account's keys are read with: a
// bounded wait, and no redirect that leaves HTTPS or github.com.
func githubClient() *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if request.URL.Scheme != "https" || request.URL.Host != "github.com" || len(via) >= 5 {
				return fmt.Errorf("refusing a redirect to %s", request.URL)
			}
			return nil
		},
	}
}

// httpsFetch reads a URL's body with client, answering trust.ErrNotFound
// for a page that is not there.
func httpsFetch(client *http.Client) trust.Fetch {
	return func(url string) ([]byte, error) {
		response, err := client.Get(url)
		if err != nil {
			return nil, err
		}
		defer func() { _ = response.Body.Close() }()
		switch {
		case response.StatusCode == http.StatusNotFound:
			return nil, trust.ErrNotFound
		case response.StatusCode != http.StatusOK:
			return nil, fmt.Errorf("%s answered %s", url, response.Status)
		}
		return io.ReadAll(io.LimitReader(response.Body, 1<<20))
	}
}

type verifyCmd struct {
	Source    string `arg:"" optional:"" default:"." help:"A bundle directory, a zip or gzipped tar of one, or a musai workspace (default: the current directory)."`
	JSON      bool   `name:"json" help:"Write the report as a run draft in canonical JSON."`
	Principal string `help:"Who stands behind the report, named as its performer (default: the current user)."`
	As        string `name:"as" help:"A receiver, key:SHA256:… or identity:<issuer>#<subject>, checked against the audience the bundle was cut for."`
	sourceFlags
}

func (c *verifyCmd) Run(e *env) error {
	src, trusted, err := c.open(c.Source)
	if err != nil {
		return err
	}
	table, err := refs.Load()
	if err != nil {
		return err
	}
	result, err := check.Run(src, table, trusted)
	if err != nil {
		return err
	}
	if c.As != "" {
		result.Findings = append(result.Findings, result.Released.Member(c.As))
	}
	if c.JSON {
		// A bundle damaged in transit has no digest; its failed report names it without one.
		digest, err := source.Digest(src.Bundle)
		if err != nil && !result.Failed() {
			return err
		}
		draft, err := report.Draft(report.Input{
			Result: result, BundleDigest: digest, Trust: trusted,
			Principal: principal(c.Principal), Version: currentVersion(), Binary: executableID(),
		})
		if err != nil {
			return err
		}
		data, err := report.Canonical(draft)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, string(data))
	} else {
		writeFindings(e.stdout, result)
		fmt.Fprintf(e.stdout, "signatures checked against %s\n", printable.String(trusted.Describe()))
	}
	if code := report.ExitCode(result); code != report.Verified {
		return exitCoder(code)
	}
	return nil
}

func principal(given string) string {
	if given != "" {
		return given
	}
	if current, err := user.Current(); err == nil && current.Username != "" {
		return current.Username
	}
	return "unknown"
}

// executableID is the id of the running binary, or empty where it cannot
// be read.
func executableID() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return canon.BlobID(data)
}

func writeFindings(w io.Writer, result check.Result) {
	counts := map[check.Severity]int{}
	for _, f := range result.Findings {
		counts[f.Severity]++
		where := f.Path
		if f.At != "" {
			where += " " + f.At
		}
		fmt.Fprintf(w, "%-7s %-28s %s: %s\n", paint(w, f.Severity, string(f.Severity)), f.Code, printable.String(where), printable.String(f.Detail))
	}
	verdict := paint(w, "verified", "verified")
	if result.Failed() {
		verdict = paint(w, check.Error, "FAILED")
	}
	fmt.Fprintf(w, "%s: %d records, %d %s verified, %d %s, %d %s\n", verdict,
		result.Records, result.Signatures, plural(result.Signatures, "signature"),
		counts[check.Error], plural(counts[check.Error], "error"),
		counts[check.Warning], plural(counts[check.Warning], "warning"))
	if released := result.Released; released.Checked {
		fmt.Fprintf(w, "released: %s — %d of %d records covered\n", printable.String(released.Audience), released.Covered, released.Total)
	} else {
		fmt.Fprintln(w, "released: not checked (no manifest)")
	}
}

func plural(n int, noun string) string {
	if n == 1 {
		return noun
	}
	return noun + "s"
}

// paint colours text on a terminal that has not asked for no colour.
func paint(w io.Writer, severity check.Severity, text string) string {
	file, ok := w.(*os.File)
	if !ok || os.Getenv("NO_COLOR") != "" {
		return text
	}
	if info, err := file.Stat(); err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return text
	}
	colours := map[check.Severity]string{check.Error: "31", check.Warning: "33", "verified": "32"}
	colour, ok := colours[severity]
	if !ok {
		return text
	}
	return "\x1b[" + colour + "m" + text + "\x1b[0m"
}

// loaded is a source read and checked, for the commands that walk it.
type loaded struct {
	index  *check.Index
	table  refs.Table
	result check.Result
	// signers are the trusted keys, which name a signer's alias.
	signers []sig.Signer
}

func load(path string, flags sourceFlags) (*loaded, error) {
	src, trusted, err := flags.open(path)
	if err != nil {
		return nil, err
	}
	table, err := refs.Load()
	if err != nil {
		return nil, err
	}
	tree, err := check.Load(src.Bundle)
	if err != nil {
		return nil, err
	}
	index, _ := check.Records(tree, table)
	result, err := check.Run(src, table, trusted)
	if err != nil {
		return nil, err
	}
	return &loaded{index: index, table: table, result: result, signers: trusted.Signers()}, nil
}

func writeJSON(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if data, err = canon.Canonical(data); err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(data))
	return err
}

type traceCmd struct {
	ID     string `arg:"" help:"A record id, or at least eight hex characters of one."`
	Source string `short:"s" default:"." help:"The bundle, zip or workspace to walk (default: the current directory)."`
	JSON   bool   `name:"json" help:"Write the walk as canonical JSON."`
	sourceFlags
}

func (c *traceCmd) Run(e *env) error {
	l, err := load(c.Source, c.sourceFlags)
	if err != nil {
		return err
	}
	id, err := trace.Resolve(l.index, c.ID)
	if err != nil {
		return err
	}
	root, err := trace.Walk(l.index, l.table, id, trace.SignatureStates(l.result), l.signers)
	if err != nil {
		return err
	}
	if c.JSON {
		return writeJSON(e.stdout, root)
	}
	fmt.Fprint(e.stdout, root.Text())
	if l.result.Failed() {
		fmt.Fprintln(e.stdout, "\nnote: the source does not verify; musai-verify verify says what failed")
	}
	return nil
}

type recipeCmd struct {
	ID     string `arg:"" help:"A run's id, or at least eight hex characters of one."`
	Source string `short:"s" default:"." help:"The bundle, zip or workspace holding the run (default: the current directory)."`
	JSON   bool   `name:"json" help:"Write the recipe as canonical JSON."`
	sourceFlags
}

func (c *recipeCmd) Run(e *env) error {
	l, err := load(c.Source, c.sourceFlags)
	if err != nil {
		return err
	}
	id, err := trace.Resolve(l.index, c.ID)
	if err != nil {
		return err
	}
	recipe, err := trace.RecipeOf(l.index, id)
	if err != nil {
		return err
	}
	if c.JSON {
		return writeJSON(e.stdout, recipe)
	}
	fmt.Fprint(e.stdout, recipe.Text())
	return nil
}

type conformanceCmd struct {
	Dir string `arg:"" type:"existingdir" help:"The conformance directory the kernel writes."`
}

func (c *conformanceCmd) Run(e *env) error {
	cases, err := conformance.Run(os.DirFS(c.Dir))
	if err != nil {
		return err
	}
	passed := 0
	for _, kase := range cases {
		mark := "fail"
		if kase.Passed {
			mark = "pass"
			passed++
		}
		line := fmt.Sprintf("%s  %s  %s", mark, kase.Suite, kase.Name)
		if kase.Detail != "" {
			line += ": " + kase.Detail
		}
		fmt.Fprintln(e.stdout, line)
	}
	fmt.Fprintf(e.stdout, "passed: %d of %d cases\n", passed, len(cases))
	if passed != len(cases) {
		return exitCoder(report.Failed)
	}
	return nil
}
