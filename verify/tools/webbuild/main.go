// Command webbuild writes the verifier's page to a directory: the page's
// own files from web/, the js/wasm build of the verifier, and the
// wasm_exec.js of the Go that built it, which the build and the page must
// share. Given a version, the page links the README at that version's tag.
// Run it from the module's root.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// pageFiles are the page's own files, copied from web/ as they are.
var pageFiles = []string{"index.html", "app.js"}

func main() {
	out := flag.String("out", "", "the directory to write the page to")
	version := flag.String("version", "devel", "the version the verifier names itself by in its reports")
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "usage: webbuild -out <dir> [-version v0.x.y]")
		os.Exit(2)
	}
	if err := build(*out, *version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(out, version string) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	compile := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w -X main.version="+version,
		"-o", filepath.Join(out, "musai-verify.wasm"), "./wasm")
	compile.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
	compile.Stdout, compile.Stderr = os.Stdout, os.Stderr
	if err := compile.Run(); err != nil {
		return fmt.Errorf("building the js/wasm verifier: %w", err)
	}
	goroot, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return fmt.Errorf("finding the Go that built the verifier: %w", err)
	}
	wasmExec := filepath.Join(strings.TrimSpace(string(goroot)), "lib", "wasm", "wasm_exec.js")
	if err := copyFile(wasmExec, filepath.Join(out, "wasm_exec.js")); err != nil {
		return err
	}
	for _, name := range pageFiles {
		if err := copyFile(filepath.Join("web", name), filepath.Join(out, name)); err != nil {
			return err
		}
	}
	if version == "devel" {
		return nil
	}
	page := filepath.Join(out, "index.html")
	html, err := os.ReadFile(page)
	if err != nil {
		return err
	}
	return os.WriteFile(page, []byte(strings.ReplaceAll(string(html), branchReadme, "blob/verify/"+version+"/verify/README.md")), 0o644)
}

// branchReadme is where the page's own link to the finding codes points
// while it is built from a branch; a released page points at its tag.
const branchReadme = "blob/main/verify/README.md"

func copyFile(from, to string) error {
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, data, 0o644)
}
