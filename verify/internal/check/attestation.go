package check

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/checkwhy/musai/verify/internal/release"
)

// The attestation versions the kernel reads; a later one is read unchecked and, released or sealed,
// counts for nothing.
const (
	oldestAttestation = 2
	newestAttestation = 6
)

var (
	principalClasses = []string{"person", "agent"}
	viaChannels      = []string{"elicitation", "tty", "signature", "model", "process"}
	purposes         = []string{"made", "asserted", "re-shared", "released", "revoked", "sealed"}
	releaseExtents   = []string{"record", "closure"}
	releaseForms     = []string{"bytes", "id"}
	releaseUses      = []string{"review", "cite", "republish"}
	releaseFields    = []string{"audience", "extent", "terms"}

	recordIDForm  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	timestampForm = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
	markingForm   = regexp.MustCompile(`^[a-z][a-z0-9+.-]*:[^` + release.JSSpace + `]+$`)
	pseudonymForm = regexp.MustCompile(`^pseudonym:[^:]+:[0-9a-f]{64}$`)
)

// attestationProblem is what an attestation of a version the kernel reads holds that the kernel
// refuses to hold, or "".
func attestationProblem(value map[string]any) string {
	version, ok := value["schemaVersion"].(float64)
	if !ok {
		return "schemaVersion is required"
	}
	if version > newestAttestation {
		return ""
	}
	if version < oldestAttestation || version != math.Trunc(version) {
		return fmt.Sprintf("schemaVersion %v has no normaliser to version %d", version, newestAttestation)
	}
	if subject, _ := value["subject"].(string); !recordIDForm.MatchString(subject) {
		return "subject must be a record id"
	}
	if version > 2 && !recordIDs(value["supersedes"]) {
		return "supersedes must be an array of record ids, empty when nothing is replaced"
	}
	principal, ok := value["principal"].(string)
	if !ok {
		return "principal must be a string"
	}
	if strings.HasPrefix(principal, "pseudonym:") && !pseudonymForm.MatchString(principal) {
		return "principal reserves the pseudonym: prefix for pseudonym:<key id>:<64 hex>"
	}
	if version == newestAttestation && release.Form(principal) != "key" && !pseudonymForm.MatchString(principal) {
		return "principal is key:SHA256:<fingerprint> or pseudonym:<key id>:<64 hex>, never a bare name"
	}
	if class, _ := value["principalClass"].(string); !slices.Contains(principalClasses, class) {
		return fmt.Sprintf("principalClass must be one of %s", strings.Join(principalClasses, ", "))
	}
	via, _ := value["via"].(string)
	if !slices.Contains(viaChannels, via) {
		return fmt.Sprintf("via must be one of %s", strings.Join(viaChannels, ", "))
	}
	purpose, _ := value["purpose"].(string)
	if !slices.Contains(purposes, purpose) {
		return fmt.Sprintf("purpose must be one of %s", strings.Join(purposes, ", "))
	}
	if at, _ := value["at"].(string); !timestampForm.MatchString(at) {
		return "at must be an RFC 3339 timestamp"
	}
	if _, has := value["class"]; has {
		return "a field named class was minted at an earlier version and is re-minted, never read"
	}
	if _, has := value["seal"]; has && purpose != "sealed" {
		return fmt.Sprintf("only a seal names seal; a %s attestation carries none", purpose)
	}
	switch purpose {
	case "released":
		return releaseProblem(value)
	case "sealed":
		return sealProblem(value, via)
	case "revoked":
		if superseded, _ := value["supersedes"].([]any); len(superseded) == 0 {
			return "a revocation's supersedes names the releases and seals it withdraws, and is never empty"
		}
	}
	return carriedReleaseFields(value, purpose)
}

// unknownVersion reports the version of a release or a seal later than any this verifier knows.
func unknownVersion(value map[string]any) (float64, bool) {
	version, _ := value["schemaVersion"].(float64)
	purpose, _ := value["purpose"].(string)
	return version, version > newestAttestation && (purpose == "released" || purpose == "sealed")
}

func recordIDs(value any) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	return !slices.ContainsFunc(items, func(item any) bool {
		text, _ := item.(string)
		return !recordIDForm.MatchString(text)
	})
}

func carriedReleaseFields(value map[string]any, purpose string) string {
	var carried []string
	for _, field := range releaseFields {
		if _, has := value[field]; has {
			carried = append(carried, field)
		}
	}
	if len(carried) > 0 {
		return fmt.Sprintf("only a release names %s; a %s attestation carries none of them", strings.Join(carried, ", "), purpose)
	}
	return ""
}

func sealProblem(value map[string]any, via string) string {
	if problem := carriedReleaseFields(value, "sealed"); problem != "" {
		return problem
	}
	if via == "model" {
		return "a seal is signed and never relayed through model"
	}
	named, _ := value["seal"].(map[string]any)
	if audience, _ := named["audience"].(string); release.Form(audience) == "" {
		return "a seal's seal.audience is public, a key, an identity or a name"
	}
	if extent, has := named["extent"]; has && extent != "closure" {
		return fmt.Sprintf("a seal's seal.extent is closure where named, and absent for the record, got %v", extent)
	}
	return ""
}

func releaseProblem(value map[string]any) string {
	if audience, _ := value["audience"].(string); release.Form(audience) == "" {
		return "a release's audience is public, a key, an identity or a name"
	}
	if extent, _ := value["extent"].(string); !slices.Contains(releaseExtents, extent) {
		return fmt.Sprintf("a release's extent is one of %s", strings.Join(releaseExtents, ", "))
	}
	terms, ok := value["terms"].(map[string]any)
	if !ok {
		return "a release's terms are an object naming form, uses, from, until and marking"
	}
	if form, _ := terms["form"].(string); !slices.Contains(releaseForms, form) {
		return fmt.Sprintf("a release's terms.form is one of %s", strings.Join(releaseForms, ", "))
	}
	uses, _ := terms["uses"].([]any)
	if !inOrder(uses) {
		return fmt.Sprintf("a release's terms.uses grants at least one of %s, each once and in that order", strings.Join(releaseUses, ", "))
	}
	var from, until *time.Time
	for _, bound := range []string{"from", "until"} {
		raw, present := terms[bound]
		text, isText := raw.(string)
		if !present || (raw != nil && (!isText || !timestampForm.MatchString(text))) {
			return fmt.Sprintf("a release's terms.%s is an RFC 3339 timestamp or null", bound)
		}
		at, err := time.Parse(time.RFC3339Nano, text)
		if raw == nil || err != nil {
			continue
		}
		if bound == "from" {
			from = &at
		} else {
			until = &at
		}
	}
	if from != nil && until != nil && !from.Before(*until) {
		return "a release's terms.from comes before its terms.until"
	}
	raw, present := terms["marking"]
	marking, isText := raw.(string)
	if !present || (raw != nil && (!isText || !markingForm.MatchString(marking))) {
		return "a release's terms.marking is null or <scheme>:<value>, the scheme in lowercase"
	}
	if slices.Contains(uses, any("republish")) && !strings.HasPrefix(marking, "spdx:") {
		return "a release granting republish names its licence as an spdx: marking"
	}
	return ""
}

// inOrder reports whether uses is non-empty and names each known use once, in a release's order.
func inOrder(uses []any) bool {
	last := -1
	for _, use := range uses {
		name, _ := use.(string)
		at := slices.Index(releaseUses, name)
		if at <= last {
			return false
		}
		last = at
	}
	return len(uses) > 0
}
