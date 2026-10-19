//go:build wasm

// Command wasm is the verifier where there is no filesystem to hand it:
// bytes of a zipped or tarred bundle in, the report as a run draft in
// canonical JSON out. Under js it registers a function a page calls; under
// wasip1 it reads the archive on stdin and writes the report on stdout.
package main

import (
	"errors"
	"fmt"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/refs"
	"github.com/checkwhy/musai/verify/internal/report"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// version is set at release with -ldflags "-X main.version=v0.x.y".
var version = "devel"

// options are the keys a receiver chose: trust specs as --trust takes
// them, and allowed-signers text where they pasted one. With neither, the
// bundle's own allowed-signers are trusted.
type options struct {
	Trust          []string
	AllowedSigners []byte
}

// answer is a verification as a caller with no terminal reads it: the
// report, and what a command line's summary would have said beside it.
type answer struct {
	Report     string
	Records    int
	Signatures int
	Trust      string
}

// noFetch refuses the one trust source that needs the network: a page
// hands the verifier keys it already holds.
func noFetch(url string) ([]byte, error) {
	return nil, fmt.Errorf("%s: this verifier fetches nothing; paste the keys as allowed-signers text: %w", url, trust.ErrSpec)
}

func trusted(src *source.Source, opts options) (trust.Set, error) {
	if len(opts.Trust) == 0 && opts.AllowedSigners == nil {
		return trust.Own(src), nil
	}
	set, err := trust.Resolve(opts.Trust, src, noFetch)
	if err != nil {
		return nil, err
	}
	if opts.AllowedSigners == nil {
		return set, nil
	}
	pasted, err := trust.FromText(opts.AllowedSigners)
	if err != nil {
		return nil, err
	}
	return set.With(pasted), nil
}

// verify checks an archived bundle and answers with its exit code.
func verify(archive []byte, principal string, opts options) (answer, int, error) {
	src, err := source.FromArchive(archive)
	if err != nil {
		return answer{}, report.Invocation, err
	}
	set, err := trusted(src, opts)
	if errors.Is(err, trust.ErrSpec) {
		return answer{}, report.Invocation, err
	}
	if err != nil {
		return answer{}, report.Broken, err
	}
	table, err := refs.Load()
	if err != nil {
		return answer{}, report.Broken, err
	}
	result, err := check.Run(src, table, set)
	if err != nil {
		return answer{}, report.Broken, err
	}
	// A bundle damaged in transit has no digest; its failed report names it without one.
	digest, err := source.Digest(src.Bundle)
	if err != nil && !result.Failed() {
		return answer{}, report.Broken, err
	}
	draft, err := report.Draft(report.Input{
		Result: result, BundleDigest: digest, Trust: set, Principal: principal, Version: version,
	})
	if err != nil {
		return answer{}, report.Broken, err
	}
	data, err := report.Canonical(draft)
	if err != nil {
		return answer{}, report.Broken, err
	}
	return answer{
		Report: string(data), Records: result.Records, Signatures: result.Signatures, Trust: set.Describe(),
	}, report.ExitCode(result), nil
}
