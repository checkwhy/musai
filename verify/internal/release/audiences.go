package release

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// JSSpace is what JavaScript's \s matches, spelled out because RE2's is ASCII only.
const JSSpace = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	keyForm      = regexp.MustCompile(`^key:SHA256:[A-Za-z0-9+/]{43}$`)
	identityForm = regexp.MustCompile(`^identity:https://[^#` + JSSpace + `]+#[^` + JSSpace + `]+$`)
	nameForm     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

// Form names an audience's form: public, key, identity or name, or the
// empty string for a form this verifier does not know.
func Form(audience string) string {
	switch {
	case audience == "public":
		return "public"
	case keyForm.MatchString(audience):
		return "key"
	case identityForm.MatchString(audience):
		return "identity"
	case nameForm.MatchString(audience):
		return "name"
	}
	return ""
}

// Audiences is a parsed audiences file: each declared name, its members
// and the names it includes.
type Audiences struct {
	members  map[string][]string
	includes map[string][]string
}

// ParseAudiences parses an audiences file as the kernel does, refusing a
// line it cannot read, an include of an undeclared name and a cycle.
func ParseAudiences(text string) (Audiences, error) {
	a := Audiences{members: map[string][]string{}, includes: map[string][]string{}}
	declare := func(name, raw string) error {
		if Form(name) != "name" {
			return fmt.Errorf("declares something other than a name: %s", raw)
		}
		if _, ok := a.members[name]; !ok {
			a.members[name] = nil
			a.includes[name] = nil
		}
		return nil
	}
	type include struct{ name, target, raw string }
	var included []include
	for raw := range strings.SplitSeq(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		switch {
		case len(fields) == 1:
			if err := declare(fields[0], raw); err != nil {
				return Audiences{}, err
			}
		case len(fields) == 3 && fields[1] == "member":
			if err := declare(fields[0], raw); err != nil {
				return Audiences{}, err
			}
			if form := Form(fields[2]); form != "key" && form != "identity" {
				return Audiences{}, fmt.Errorf("a member is a key or an identity: %s", raw)
			}
			a.members[fields[0]] = append(a.members[fields[0]], fields[2])
		case len(fields) == 3 && fields[1] == "includes":
			if err := declare(fields[0], raw); err != nil {
				return Audiences{}, err
			}
			included = append(included, include{fields[0], fields[2], raw})
		default:
			return Audiences{}, fmt.Errorf("not an audiences file line: %s", raw)
		}
	}
	for _, in := range included {
		if _, ok := a.members[in.target]; !ok {
			return Audiences{}, fmt.Errorf("includes an audience this file does not declare: %s", in.raw)
		}
		a.includes[in.name] = append(a.includes[in.name], in.target)
	}
	if cycle := a.cycle(); cycle != nil {
		return Audiences{}, fmt.Errorf("the audiences file declares a cycle: %s", strings.Join(cycle, " includes "))
	}
	return a, nil
}

func (a Audiences) cycle() []string {
	names := make([]string, 0, len(a.includes))
	for name := range a.includes {
		names = append(names, name)
	}
	slices.Sort(names)
	done := map[string]bool{}
	var visit func(name string, path []string) []string
	visit = func(name string, path []string) []string {
		if i := slices.Index(path, name); i >= 0 {
			return append(slices.Clone(path[i:]), name)
		}
		if done[name] {
			return nil
		}
		for _, target := range a.includes[name] {
			if cycle := visit(target, append(slices.Clone(path), name)); cycle != nil {
				return cycle
			}
		}
		done[name] = true
		return nil
	}
	for _, name := range names {
		if cycle := visit(name, nil); cycle != nil {
			return cycle
		}
	}
	return nil
}

func (a Audiences) reached(name string) map[string]bool {
	reached := map[string]bool{}
	pending := []string{name}
	for len(pending) > 0 {
		next := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if reached[next] {
			continue
		}
		reached[next] = true
		pending = append(pending, a.includes[next]...)
	}
	return reached
}

// Covers reports whether a release to granted reaches target: public
// covers everything, a name covers what it reaches through includes and
// those names' members, and a key or an identity covers only itself.
func (a Audiences) Covers(granted, target string) bool {
	if granted == "public" || granted == target {
		return true
	}
	if Form(granted) != "name" || target == "public" {
		return false
	}
	reached := a.reached(granted)
	if Form(target) == "name" {
		return reached[target]
	}
	for name := range reached {
		if slices.Contains(a.members[name], target) {
			return true
		}
	}
	return false
}
