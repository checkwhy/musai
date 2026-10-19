// Package release reads what a bundle says about who may receive it: the
// roles and audiences trust files, the releases and revocations its
// attestations carry, and which records a standing release covers. The
// kernel's role table is conformance/roles.json, embedded here byte for byte.
package release

import (
	_ "embed"
	"encoding/json/v2"
	"fmt"
	"slices"
	"strings"
)

//go:embed roles.json
var embeddedRoles []byte

type roleTable struct {
	Roles        map[string][]string `json:"roles"`
	EmptyDefault []string            `json:"emptyDefault"`
}

// Grant is one line of a roles file: a principal holds a role at a scope.
type Grant struct {
	Principal string
	Role      string
	Scope     string
}

// Roles is a parsed roles file, read beside the allowed signers it was
// shipped with.
type Roles struct {
	Grants []Grant
	// NoSigners is true where the allowed-signers file names nobody.
	NoSigners bool
	table     roleTable
}

// ParseRoles parses a roles file as the kernel does: one principal, role
// and scope per line, `#` starting a comment, a role the table names.
func ParseRoles(text string, noSigners bool) (Roles, error) {
	var table roleTable
	if err := json.Unmarshal(embeddedRoles, &table); err != nil {
		return Roles{}, err
	}
	roles := Roles{NoSigners: noSigners, table: table}
	for raw := range strings.SplitSeq(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			return Roles{}, fmt.Errorf("not a roles file line: %s", raw)
		}
		if _, known := table.Roles[fields[1]]; !known {
			return Roles{}, fmt.Errorf("not a shipped role: %s", fields[1])
		}
		roles.Grants = append(roles.Grants, Grant{Principal: fields[0], Role: fields[1], Scope: fields[2]})
	}
	return roles, nil
}

// HoldsPublish reports whether a principal holds publish at scope any, or
// whether an empty trust branch grants it to everyone.
func (r Roles) HoldsPublish(principal string) bool {
	if len(r.Grants) == 0 && r.NoSigners {
		return slices.Contains(r.table.EmptyDefault, "publish")
	}
	return slices.ContainsFunc(r.Grants, func(g Grant) bool {
		return g.Principal == principal && g.Scope == "any" && slices.Contains(r.table.Roles[g.Role], "publish")
	})
}
