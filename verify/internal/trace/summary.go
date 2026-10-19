package trace

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/sig"
)

// summary says what a record says of itself in one line.
func summary(record *check.Record, signatures map[string]string, signers []sig.Signer) string {
	v := record.Value
	switch record.Kind {
	case "claim":
		return join(str(v, "type"), text(v["rendering"]), declaredCommand(v))
	case "argument":
		return text(v["reason"])
	case "run":
		return join(str(v, "runKind"), performer(v), determinism(v))
	case "ruling":
		return join(str(v, "verdict"), text(v["reason"]))
	case "rule":
		return join(str(v, "name"), "weight "+str(v, "weight"))
	case "case":
		return str(v, "slug")
	case "artifact":
		return join(str(v, "lifecycle"), str(v, "format"))
	case "attestation":
		state, ok := signatures[record.ID]
		if !ok {
			state = "unsigned"
		}
		purpose, extent := str(v, "purpose"), ""
		if seal, ok := v["seal"].(map[string]any); ok {
			purpose += " from " + str(seal, "audience")
			if named := str(seal, "extent"); named != "" {
				extent = "extent " + named
			}
		}
		return join(fmt.Sprintf("%s by %s via %s", purpose, signer(str(v, "principal"), signers), str(v, "via")), extent, str(v, "class"), state)
	case "module":
		return str(v, "name") + "@" + str(v, "version")
	}
	return ""
}

// declarativeRule is the condition a check claim states its recipe under.
const declarativeRule = "musai.core/declarative"

// declaredCommand is the command a check claim's declared recipe runs, or
// nothing for a claim another rule judges.
func declaredCommand(v map[string]any) string {
	conditions, _ := v["conditions"].(map[string]any)
	declared, ok := conditions[declarativeRule].(string)
	if !ok {
		return ""
	}
	var parameters struct {
		Recipes []struct {
			Recipe struct {
				Command []string `json:"command"`
			} `json:"recipe"`
		} `json:"recipes"`
	}
	if json.Unmarshal([]byte(declared), &parameters) != nil || len(parameters.Recipes) == 0 {
		return ""
	}
	if command := parameters.Recipes[0].Recipe.Command; len(command) > 0 {
		return "runs " + ShellQuote(command)
	}
	return ""
}

// signer names a principal with the alias the trusted signers list beside
// its key, which is for display and decides nothing.
func signer(principal string, signers []sig.Signer) string {
	if alias := sig.Alias(signers, principal); alias != "" {
		return fmt.Sprintf("%s (%s)", alias, principal)
	}
	return principal
}

func str(v map[string]any, key string) string {
	s, _ := v[key].(string)
	return s
}

func text(value any) string {
	s, ok := value.(string)
	if !ok {
		if value == nil {
			return ""
		}
		return "[sealed]"
	}
	s = strings.Join(strings.Fields(s), " ")
	if runes := []rune(s); len(runes) > 72 {
		return string(runes[:71]) + "…"
	}
	return s
}

func performer(v map[string]any) string {
	p, ok := v["performer"].(map[string]any)
	if !ok {
		return "performer not recorded"
	}
	switch str(p, "kind") {
	case "runner":
		return "performed by the musai runner " + str(p, "version")
	case "module":
		return fmt.Sprintf("performed by module %s/%s %s", str(p, "module"), str(p, "name"), str(p, "version"))
	case "foreign":
		return fmt.Sprintf("performed by %s with %s %s", str(p, "principal"), str(p, "tool"), str(p, "version"))
	}
	return "performer " + str(p, "kind")
}

func determinism(v map[string]any) string {
	if d := str(v, "determinism"); d != "" {
		return d
	}
	return "determinism not recorded"
}

func join(parts ...string) string {
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " · ")
}
