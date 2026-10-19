// Command musai-verify checks a musai bundle or workspace without Node,
// git or ssh-keygen: that every record's id recomputes from its bytes,
// that every reference resolves, that every signature verifies as
// ssh-keygen would answer, and that every held blob is the one named. It
// reads and checks; it never mints a record and never computes a status.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"

	"github.com/alecthomas/kong"

	"github.com/checkwhy/musai/verify/internal/report"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trace"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// version is set at release with -ldflags "-X main.version=v0.x.y".
var version string

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// currentVersion is the release version, else the module version go
// install recorded, else devel.
func currentVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "devel"
}

type cli struct {
	Version     kong.VersionFlag `help:"Print the version and exit."`
	Verify      verifyCmd        `cmd:"" help:"Check a bundle, a zip or gzipped tar of one, or a musai workspace: ids, references, signatures and blobs."`
	Trace       traceCmd         `cmd:"" help:"Walk the citation graph from one record."`
	Recipe      recipeCmd        `cmd:"" help:"Print what a receiver needs to re-run a run."`
	Conformance conformanceCmd   `cmd:"" help:"Run the shared conformance corpus against this verifier."`
}

// env is what a command writes to.
type env struct {
	stdout, stderr io.Writer
}

// invocationError marks a failure the caller fixes by changing the call.
type invocationError struct{ error }

func (e invocationError) Unwrap() error { return e.error }

// exitCoder is a command outcome that is not success yet not an error.
type exitCoder int

func (e exitCoder) Error() string { return fmt.Sprintf("exit %d", int(e)) }

func run(args []string, stdout, stderr io.Writer) (code int) {
	var c cli
	exited := -1
	parser, err := kong.New(&c,
		kong.Name("musai-verify"),
		kong.Description("Checks a musai bundle or workspace as its receiver: ids, references, signatures and blobs."),
		kong.Vars{"version": currentVersion()},
		kong.Writers(stdout, stderr),
		kong.Exit(func(code int) { exited = code; panic(exitSignal{}) }),
		kong.UsageOnError(),
	)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return report.Broken
	}
	defer recoverTo(stderr, &exited, &code)
	ctx, err := parser.Parse(args)
	if err != nil {
		fmt.Fprintln(stderr, "musai-verify:", err)
		return report.Invocation
	}
	return exitCode(ctx.Run(&env{stdout: stdout, stderr: stderr}), stderr)
}

// exitSignal unwinds a parse that kong ends early, for help or a version.
type exitSignal struct{}

// recoverTo ends a run that panicked: kong's own early exit with the code
// it asked for, and anything else as the verifier having failed, which is
// exit 1 and never the invocation's fault.
func recoverTo(stderr io.Writer, exited, code *int) {
	switch recovered := recover(); recovered {
	case nil:
	case exitSignal{}:
		*code = *exited
	default:
		fmt.Fprintln(stderr, "musai-verify: the verifier failed:", recovered)
		*code = report.Broken
	}
}

func exitCode(err error, stderr io.Writer) int {
	var code exitCoder
	var invocation invocationError
	switch {
	case err == nil:
		return report.Verified
	case errors.As(err, &code):
		return int(code)
	case errors.As(err, &invocation), errors.Is(err, source.ErrNotASource), errors.Is(err, trace.ErrNoSuchRecord),
		errors.Is(err, trace.ErrAmbiguous), errors.Is(err, trace.ErrPrefixTooShort), errors.Is(err, trace.ErrNotARun),
		errors.Is(err, trust.ErrSpec):
		fmt.Fprintln(stderr, "musai-verify:", err)
		return report.Invocation
	}
	fmt.Fprintln(stderr, "musai-verify: the verifier failed:", err)
	return report.Broken
}
