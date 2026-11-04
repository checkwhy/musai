package trace

import (
	"maps"
	"path"
	"slices"
	"strings"
	"unicode/utf16"
)

// The engine line is the kernel's container argv, held to it by conformance/recipes.json.
const (
	imageMediaType      = "application/vnd.oci.image.manifest.v1+json"
	checkoutVariable    = "MUSAI_CHECKOUT"
	checkoutPlaceholder = "${" + checkoutVariable + ":?set it to your checkout}"
	freshScratch        = "$(mktemp -d)"
	mountRoot           = "/musai/tree"
	scratchRoot         = "/musai/scratch"
	privateRoot         = "/musai/private"
)

// privateDirectories are a run's own scratch directories, each a tmpfs inside the container.
var privateDirectories = []string{"home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state"}

// hygiene is the environment the kernel assigns every run, as a container finds it.
var hygiene = []string{
	"HOME=" + privateRoot + "/home",
	"TMPDIR=" + privateRoot + "/tmp",
	"TEMP=" + privateRoot + "/tmp",
	"TMP=" + privateRoot + "/tmp",
	"XDG_CONFIG_HOME=" + privateRoot + "/xdg-config",
	"XDG_CACHE_HOME=" + privateRoot + "/xdg-cache",
	"XDG_DATA_HOME=" + privateRoot + "/xdg-data",
	"XDG_STATE_HOME=" + privateRoot + "/xdg-state",
	"SSH_AUTH_SOCK=",
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_CONFIG_GLOBAL=" + scratchRoot + "/unwritten-global-config",
}

// engineLine is what a stranger types to perform a container run by hand, with the indexes of its
// two mounts, or nil where the run was held outside a container.
func engineLine(r Recipe, observation map[string]any) ([]string, []int) {
	index := slices.IndexFunc(r.Substrates, func(s Substrate) bool { return s.MediaType == imageMediaType })
	if str(observation, "isolationHeld") != "container" || index == -1 || r.Substrates[index].URI == "" ||
		len(r.Command) == 0 {
		return nil, nil
	}
	resolved := objects(observation["resolved"])
	if index >= len(resolved) {
		return nil, nil
	}
	digest := stringMap(resolved[index]["digest"])["sha256"]
	if digest == "" {
		return nil, nil
	}
	// Uncleaned, as cleaning against a placeholder drops a leading `..` with the checkout before it.
	tree := r.WorkingDirectory
	switch {
	case path.IsAbs(tree):
	case tree == ".":
		tree = checkoutPlaceholder
	default:
		tree = checkoutPlaceholder + "/" + tree
	}
	line := []string{
		"docker", "run", "--rm", "--network", "none",
		"-v", tree + ":" + mountRoot + ":ro", "-v", freshScratch + ":" + scratchRoot + ":rw",
	}
	mounts := []int{6, 8}
	for _, directory := range privateDirectories {
		line = append(line, "--tmpfs", privateRoot+"/"+directory+":exec,mode=1777")
	}
	line = append(line, "-w", mountRoot)
	for _, entry := range environmentEntries(r.Environment, r.Declared) {
		line = append(line, "-e", entry)
	}
	line = append(line, "--entrypoint", r.Command[0], imageRepository(r.Substrates[index].URI)+"@sha256:"+digest)
	return append(line, r.Command[1:]...), mounts
}

// environmentEntries orders as the kernel does: hygiene, the literals in RFC 8785 key order, then
// each declared name once, which the engine reads from its caller's environment.
func environmentEntries(literals map[string]string, declared []Declared) []string {
	names := map[string]bool{}
	var order []string
	for _, entry := range declared {
		if !names[entry.Name] {
			names[entry.Name] = true
			order = append(order, entry.Name)
		}
	}
	keys := slices.Collect(maps.Keys(literals))
	slices.SortFunc(keys, func(a, b string) int {
		return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
	})
	entries := slices.Clone(hygiene)
	for _, key := range keys {
		if names[key] {
			entries = append(entries, key)
		} else {
			entries = append(entries, key+"="+literals[key])
		}
	}
	for _, name := range order {
		if _, literal := literals[name]; !literal {
			entries = append(entries, name)
		}
	}
	return entries
}

// imageRepository strips a tag so the digest replaces it; a colon before the last slash is a port.
func imageRepository(uri string) string {
	from := strings.LastIndex(uri, "/") + 1
	if colon := strings.Index(uri[from:], ":"); colon != -1 {
		return uri[:from+colon]
	}
	return uri
}

// engineShell writes the line for a POSIX shell, leaving the placeholder that opens each mount
// for the shell to expand.
func engineShell(line []string, mounts []int) string {
	quoted := make([]string, len(line))
	for i, arg := range line {
		quoted[i] = quote(arg)
	}
	for _, i := range mounts {
		for _, placeholder := range []string{checkoutPlaceholder, freshScratch} {
			if rest, ok := strings.CutPrefix(line[i], placeholder); ok {
				quoted[i] = `"` + placeholder + `"` + quote(rest)
			}
		}
	}
	return strings.Join(quoted, " ")
}
