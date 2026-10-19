// Package report writes a verification as a run draft in the kernel's
// own field names: a run performed by a foreign tool, whose recipe names
// the bundle by digest and the verifier by version, and whose observation
// carries the findings as canonical JSON and the verdict as its exit code.
// The draft carries no schema version and no id: admitting it, as a
// citation or otherwise, is the kernel's to do.
package report

import (
	"encoding/json/v2"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// The exit codes of a verification, following the kernel's table where the
// meanings match.
const (
	Verified   = 0
	Broken     = 1
	Invocation = 2
	Failed     = 3
)

// Tool is the name the verifier performs under.
const Tool = "musai-verify"

// Module is the Go module the verifier is built from.
const Module = "github.com/checkwhy/musai/verify"

// Descriptor names a substrate by locator, digest or both.
type Descriptor struct {
	Name        string            `json:"name,omitempty"`
	URI         string            `json:"uri,omitempty"`
	Digest      map[string]string `json:"digest,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// ReadEntry is one read: the key it was read by and the digest of what it consumed.
type ReadEntry struct {
	Key      string            `json:"key"`
	Consumed map[string]string `json:"consumed"`
}

// Performer is who performed the run.
type Performer struct {
	Kind      string `json:"kind"`
	Principal string `json:"principal"`
	Tool      string `json:"tool"`
	Version   string `json:"version"`
}

// Declared is a name a recipe needs bound; the verifier declares none.
type Declared struct {
	Name   string `json:"name"`
	Secret bool   `json:"secret"`
}

// Recipe is the portable half: what a receiver re-runs.
type Recipe struct {
	Command          []string          `json:"command"`
	WorkingDirectory string            `json:"workingDirectory"`
	Environment      map[string]string `json:"environment"`
	Declared         []Declared        `json:"declared"`
	Substrates       []Descriptor      `json:"substrates"`
	Isolation        string            `json:"isolation"`
}

// Binary is a binary the observation names by digest.
type Binary struct {
	Name   string `json:"name"`
	Digest string `json:"digest"`
}

// Observation is what this machine saw.
type Observation struct {
	Resolved      []Descriptor `json:"resolved"`
	IsolationHeld string       `json:"isolationHeld"`
	Binaries      []Binary     `json:"binaries"`
	Bindings      []struct{}   `json:"bindings"`
	Output        string       `json:"output"`
	OutputLossy   bool         `json:"outputLossy"`
	ExitCode      int          `json:"exitCode"`
	Scrubbed      []struct{}   `json:"scrubbed"`
	Reads         []ReadEntry  `json:"reads"`
	Cost          struct{}     `json:"cost"`
}

// RunDraft is a run record without its schema version.
type RunDraft struct {
	Kind        string      `json:"kind"`
	RunKind     string      `json:"runKind"`
	Performer   Performer   `json:"performer"`
	Determinism string      `json:"determinism"`
	Recipe      Recipe      `json:"recipe"`
	Observation Observation `json:"observation"`
	Supersedes  []string    `json:"supersedes"`
}

// Input is what a draft is written from.
type Input struct {
	Result check.Result
	// BundleDigest is the bundle's digest from source.Digest, empty for a
	// bundle holding a file it cannot read.
	BundleDigest string
	// Trust is what the signatures were checked against; an anchor with a
	// substrate is named in the recipe, the source's own trust is not.
	Trust     trust.Set
	Principal string
	Version   string
	// Binary is the verifier executable's id, empty where it cannot be read.
	Binary string
}

// ExitCode is the verdict of a result.
func ExitCode(result check.Result) int {
	if result.Failed() {
		return Failed
	}
	return Verified
}

// Draft writes a verification as a run draft.
func Draft(in Input) (RunDraft, error) {
	// The bundle is named by its substrate, never as the working directory,
	// so nothing a sender put in it can stand for a trust source a receiver
	// binds beside it.
	command := []string{Tool, "verify", "bundle"}
	bundle := Descriptor{Name: "bundle"}
	if in.BundleDigest != "" {
		bundle.Digest = map[string]string{"sha256": in.BundleDigest}
	}
	substrates := []Descriptor{
		bundle,
		{Name: Tool, URI: "pkg:golang/" + Module + "@" + in.Version, Annotations: map[string]string{"version": in.Version}},
	}
	for _, anchor := range in.Trust {
		if anchor.Substrate == nil {
			continue
		}
		command = append(command, "--trust", anchor.Argument)
		substrates = append(substrates, Descriptor{
			Name: anchor.Substrate.Name, URI: anchor.Substrate.URI,
			Digest: anchor.Substrate.Digest, Annotations: anchor.Substrate.Annotations,
		})
	}
	var binaries []Binary
	if in.Binary != "" {
		binaries = []Binary{{Name: Tool, Digest: canon.Hex(in.Binary)}}
	}
	findings := in.Result.Findings
	if findings == nil {
		findings = []check.Finding{}
	}
	output, err := json.Marshal(findings)
	if err == nil {
		output, err = canon.Canonical(output)
	}
	if err != nil {
		return RunDraft{}, err
	}
	return RunDraft{
		Kind:        "run",
		RunKind:     "run",
		Performer:   Performer{Kind: "foreign", Principal: in.Principal, Tool: Tool, Version: in.Version},
		Determinism: "deterministic",
		Recipe: Recipe{
			Command:          command,
			WorkingDirectory: ".",
			Environment:      map[string]string{},
			Substrates:       substrates,
			Isolation:        "none",
		},
		Observation: Observation{
			IsolationHeld: "none",
			Binaries:      binaries,
			Output:        string(output),
			ExitCode:      ExitCode(in.Result),
		},
	}, nil
}

// Canonical returns a draft's RFC 8785 canonical bytes.
func Canonical(draft RunDraft) ([]byte, error) {
	data, err := json.Marshal(draft)
	if err != nil {
		return nil, err
	}
	return canon.Canonical(data)
}
