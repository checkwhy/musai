package trace

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/printable"
)

// ErrNotARun refuses a recipe for a record that is not a run.
var ErrNotARun = errors.New("the record is not a run")

// computedKinds are the run kinds the kernel computes, whose recipe is a command over substrates.
var computedKinds = map[string]bool{"brief": true, "evaluation": true}

// Recipe is what a receiver needs to re-run a run, read from its recipe.
type Recipe struct {
	Run              string            `json:"run"`
	RunKind          string            `json:"runKind"`
	Command          []string          `json:"command"`
	Shell            string            `json:"shell"`
	WorkingDirectory string            `json:"workingDirectory"`
	Environment      map[string]string `json:"environment"`
	Declared         []Declared        `json:"declared"`
	Substrates       []Substrate       `json:"substrates"`
	Tooling          []string          `json:"tooling"`
	Isolation        string            `json:"isolation"`
}

// Declared is a name the recipe needs bound from outside its environment.
type Declared struct {
	Name   string `json:"name"`
	Secret bool   `json:"secret"`
}

// Substrate is one resource the recipe stands on.
type Substrate struct {
	Name        string            `json:"name"`
	URI         string            `json:"uri,omitempty"`
	Digest      map[string]string `json:"digest,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// RecipeOf reads the recipe of a held run.
func RecipeOf(index *check.Index, id string) (Recipe, error) {
	record, ok := index.Records[id]
	if !ok {
		return Recipe{}, fmt.Errorf("%s: %w", id, ErrNoSuchRecord)
	}
	if record.Kind != "run" {
		return Recipe{}, fmt.Errorf("%s is a %s: %w", id, record.Kind, ErrNotARun)
	}
	raw, _ := record.Value["recipe"].(map[string]any)
	r := Recipe{
		Run:              id,
		RunKind:          str(record.Value, "runKind"),
		Command:          stringList(raw["command"]),
		WorkingDirectory: str(raw, "workingDirectory"),
		Environment:      stringMap(raw["environment"]),
		Tooling:          stringList(raw["tooling"]),
		Isolation:        str(raw, "isolation"),
	}
	r.Shell = ShellQuote(r.Command)
	for _, entry := range objects(raw["declared"]) {
		secret, _ := entry["secret"].(bool)
		r.Declared = append(r.Declared, Declared{Name: str(entry, "name"), Secret: secret})
	}
	for _, entry := range objects(raw["substrates"]) {
		r.Substrates = append(r.Substrates, Substrate{
			Name: str(entry, "name"), URI: str(entry, "uri"),
			Digest: stringMap(entry["digest"]), Annotations: stringMap(entry["annotations"]),
		})
	}
	return r, nil
}

func stringList(value any) []string {
	var out []string
	if list, ok := value.([]any); ok {
		for _, entry := range list {
			if s, ok := entry.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func objects(value any) []map[string]any {
	var out []map[string]any
	if list, ok := value.([]any); ok {
		for _, entry := range list {
			if object, ok := entry.(map[string]any); ok {
				out = append(out, object)
			}
		}
	}
	return out
}

func stringMap(value any) map[string]string {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for key, entry := range object {
		if s, ok := entry.(string); ok {
			out[key] = s
		}
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// Text renders the recipe for a person about to re-run it.
func (r Recipe) Text() string {
	var b strings.Builder
	line := func(format string, args ...any) { b.WriteString(printable.String(fmt.Sprintf(format, args...)) + "\n") }
	line("run %s  %s", r.Run, r.RunKind)
	computed := computedKinds[r.RunKind]
	if !computed {
		line("isolation          %s", r.Isolation)
		line("working directory  %s  (relative to a substrate, never this machine)", r.WorkingDirectory)
	}
	line("substrates")
	if len(r.Substrates) == 0 {
		line("  (none)")
	}
	for _, s := range r.Substrates {
		var parts []string
		for _, algorithm := range sortedKeys(s.Digest) {
			parts = append(parts, algorithm+" "+s.Digest[algorithm])
		}
		if s.URI != "" {
			parts = append(parts, s.URI)
		}
		for _, key := range sortedKeys(s.Annotations) {
			parts = append(parts, key+"="+s.Annotations[key])
		}
		line("  %-24s %s", s.Name, strings.Join(parts, "  "))
	}
	if computed {
		line("command")
		line("  %s", r.Shell)
		return b.String()
	}
	line("tooling            %s", orNone(r.Tooling))
	line("environment")
	if len(r.Environment) == 0 {
		line("  (empty)")
	}
	for _, key := range sortedKeys(r.Environment) {
		line("  %s", ShellQuote([]string{key + "=" + r.Environment[key]}))
	}
	var declared []string
	for _, d := range r.Declared {
		if d.Secret {
			declared = append(declared, d.Name+" (secret)")
		} else {
			declared = append(declared, d.Name)
		}
	}
	line("declared           %s", orNone(declared))
	line("command")
	line("  %s", r.Shell)
	return b.String()
}

func orNone(list []string) string {
	if len(list) == 0 {
		return "(none)"
	}
	return strings.Join(list, ", ")
}

// ShellQuote writes arguments as one POSIX shell line, quoting an argument
// only where a shell would split or expand it.
func ShellQuote(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = quote(arg)
	}
	return strings.Join(quoted, " ")
}

func quote(arg string) string {
	if arg != "" && strings.IndexFunc(arg, unsafe) == -1 {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// unsafe reports a character a POSIX shell would split on or expand.
func unsafe(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return false
	}
	return !strings.ContainsRune("_@%+=:,./-", c)
}
