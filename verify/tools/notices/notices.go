package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// target is one platform a release builds, with the package it builds there.
type target struct {
	goos, goarch, pkg string
}

var releaseTargets = []target{
	{"linux", "amd64", "./cmd/musai-verify"},
	{"linux", "arm64", "./cmd/musai-verify"},
	{"darwin", "amd64", "./cmd/musai-verify"},
	{"darwin", "arm64", "./cmd/musai-verify"},
	{"windows", "amd64", "./cmd/musai-verify"},
	{"windows", "arm64", "./cmd/musai-verify"},
	{"js", "wasm", "./wasm"},
	{"wasip1", "wasm", "./wasm"},
}

var allowed = map[string]bool{
	"MIT":          true,
	"BSD-2-Clause": true,
	"BSD-3-Clause": true,
	"Apache-2.0":   true,
	"ISC":          true,
}

// signature names a licence by phrases its text carries and phrases it never does.
type signature struct {
	id      string
	carries []string
	lacks   []string
}

var signatures = []signature{
	{id: "Apache-2.0", carries: []string{"apache license", "version 2.0, january 2004"}},
	{id: "MPL-2.0", carries: []string{"mozilla public license version 2.0"}},
	{id: "MIT", carries: []string{"permission is hereby granted, free of charge, to any person obtaining a copy"}},
	{id: "ISC", carries: []string{
		"permission to use, copy, modify, and",
		"distribute this software for any purpose with or without fee is hereby granted",
	}},
	{
		id:      "BSD-3-Clause",
		carries: []string{"redistribution and use in source and binary forms", "endorse or promote products"},
		lacks:   []string{"all advertising materials"},
	},
	{
		id:      "BSD-2-Clause",
		carries: []string{"redistribution and use in source and binary forms"},
		lacks:   []string{"endorse or promote products", "all advertising materials"},
	},
}

var (
	licenceName = regexp.MustCompile(`(?i)^(licen[cs]e|copying)`)
	noticeName  = regexp.MustCompile(`(?i)^(notice|patents)`)
	spdxHeader  = regexp.MustCompile(`SPDX-License-Identifier:\s*(\S.*?)\s*(\*/)?\s*$`)
	whitespace  = regexp.MustCompile(`\s+`)
)

// licencesIn names every licence whose signature a text matches.
func licencesIn(text []byte) []string {
	normal := whitespace.ReplaceAllString(strings.ToLower(string(text)), " ")
	var ids []string
	for _, sig := range signatures {
		if containsAll(normal, sig.carries) && !containsAny(normal, sig.lacks) {
			ids = append(ids, sig.id)
		}
	}
	return ids
}

func containsAll(text string, phrases []string) bool {
	for _, phrase := range phrases {
		if !strings.Contains(text, phrase) {
			return false
		}
	}
	return true
}

func containsAny(text string, phrases []string) bool {
	for _, phrase := range phrases {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

// declaredLicence is the SPDX identifier a source file's header names, or "" where none does.
func declaredLicence(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	lines := bufio.NewScanner(file)
	for read := 0; read < 30 && lines.Scan(); read++ {
		if match := spdxHeader.FindStringSubmatch(lines.Text()); match != nil {
			return match[1], nil
		}
	}
	return "", lines.Err()
}

// licenceText is one licence file and every licence it reads as.
type licenceText struct {
	path     string
	licences []string
}

// licenceDir is one directory's licence texts and the notices that go with them.
type licenceDir struct {
	texts   []licenceText
	notices []string
}

func readLicenceDir(dir string) (licenceDir, error) {
	var found licenceDir
	entries, err := os.ReadDir(dir)
	if err != nil {
		return found, err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		switch {
		case entry.IsDir():
		case noticeName.MatchString(entry.Name()):
			found.notices = append(found.notices, path)
		case licenceName.MatchString(entry.Name()):
			text, err := os.ReadFile(path)
			if err != nil {
				return found, err
			}
			found.texts = append(found.texts, licenceText{path, licencesIn(text)})
		}
	}
	return found, nil
}

// alone is the text reading as `licence` and nothing else, or "" where the directory has none.
func (d licenceDir) alone(licence string) string {
	for _, text := range d.texts {
		if len(text.licences) == 1 && text.licences[0] == licence {
			return text.path
		}
	}
	return ""
}

// covered is what one compiled file falls under, and the texts that say so.
type covered struct {
	licences []string
	texts    []string
}

// module gathers what a release compiles in from one module.
type module struct {
	path, version, dir string
	files              map[string]bool
}

// coverOf finds what a compiled file falls under: its SPDX header's licence, else the licences
// of the nearest directory up to the module's root that ships a licence text.
func coverOf(file, moduleDir string, dirs map[string]licenceDir) (covered, error) {
	declared, err := declaredLicence(file)
	if err != nil {
		return covered{}, err
	}
	rel, _ := filepath.Rel(moduleDir, file)
	for dir := filepath.Dir(file); ; dir = filepath.Dir(dir) {
		found, ok := dirs[dir]
		if !ok {
			if found, err = readLicenceDir(dir); err != nil {
				return covered{}, err
			}
			dirs[dir] = found
		}
		switch {
		case declared != "":
			if text := found.alone(declared); text != "" {
				return covered{[]string{declared}, append([]string{text}, found.notices...)}, nil
			}
		case len(found.texts) == 1 && len(found.texts[0].licences) > 0:
			return covered{found.texts[0].licences, append([]string{found.texts[0].path}, found.notices...)}, nil
		case len(found.texts) > 0:
			return covered{}, fmt.Errorf(
				"%s ships beside licence texts that do not read as one, and names none in its header", rel)
		}
		if dir == moduleDir || filepath.Dir(dir) == dir {
			break
		}
	}
	if declared != "" {
		return covered{}, fmt.Errorf("%s names %s in its header, and its module ships no %s text", rel, declared, declared)
	}
	return covered{}, fmt.Errorf("%s ships no licence text to give with its copy", rel)
}

// noticesOf renders one module's section, refusing a licence off the allow-list.
func (m *module) noticesOf(dirs map[string]licenceDir) (string, error) {
	files := make([]string, 0, len(m.files))
	for file := range m.files {
		files = append(files, file)
	}
	sort.Strings(files)
	licences := map[string]bool{}
	texts := map[string]bool{}
	for _, file := range files {
		cover, err := coverOf(file, m.dir, dirs)
		if err != nil {
			return "", fmt.Errorf("%s %s: %w", m.path, m.version, err)
		}
		for _, licence := range cover.licences {
			if !allowed[licence] {
				rel, _ := filepath.Rel(m.dir, file)
				return "", fmt.Errorf("%s %s compiles in %s under %s, which is off the allow-list (%s)",
					m.path, m.version, rel, licence, strings.Join(sortedKeys(allowed), ", "))
			}
			licences[licence] = true
		}
		for _, text := range cover.texts {
			texts[text] = true
		}
	}
	return section(fmt.Sprintf("%s %s", m.path, m.version), licences, texts)
}

func section(name string, licences, texts map[string]bool) (string, error) {
	var out strings.Builder
	fmt.Fprintf(&out, "\n==== %s (%s) ====\n\n", name, strings.Join(sortedKeys(licences), " AND "))
	for _, path := range sortedKeys(texts) {
		text, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		out.Write(text)
	}
	return out.String(), nil
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type listed struct {
	Dir      string
	Standard bool
	Module   *struct {
		Path, Version, Dir string
		Main               bool
	}
	GoFiles, CgoFiles, SFiles, HFiles []string
}

// compiledModules lists, for each module but the main one, the files any release target compiles.
func compiledModules(root string) (map[string]*module, error) {
	modules := map[string]*module{}
	for _, t := range releaseTargets {
		list := exec.Command("go", "list", "-deps", "-json=Dir,Standard,Module,GoFiles,CgoFiles,SFiles,HFiles", t.pkg)
		list.Dir = root
		list.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+t.goos, "GOARCH="+t.goarch)
		list.Stderr = os.Stderr
		out, err := list.Output()
		if err != nil {
			return nil, fmt.Errorf("go list for %s/%s: %w", t.goos, t.goarch, err)
		}
		decoder := json.NewDecoder(bytes.NewReader(out))
		for {
			var pkg listed
			if err := decoder.Decode(&pkg); errors.Is(err, io.EOF) {
				break
			} else if err != nil {
				return nil, err
			}
			if pkg.Standard || pkg.Module == nil || pkg.Module.Main {
				continue
			}
			if pkg.Module.Dir == "" {
				return nil, fmt.Errorf("%s %s lists no source directory to read its licence from", pkg.Module.Path, pkg.Module.Version)
			}
			m, ok := modules[pkg.Module.Path]
			if !ok {
				m = &module{path: pkg.Module.Path, version: pkg.Module.Version, dir: pkg.Module.Dir, files: map[string]bool{}}
				modules[m.path] = m
			}
			for _, names := range [][]string{pkg.GoFiles, pkg.CgoFiles, pkg.SFiles, pkg.HFiles} {
				for _, name := range names {
					m.files[filepath.Join(pkg.Dir, name)] = true
				}
			}
		}
	}
	return modules, nil
}

func goEnv(root string) (goroot, version string, err error) {
	env := exec.Command("go", "env", "GOROOT", "GOVERSION")
	env.Dir = root
	out, err := env.Output()
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", "", fmt.Errorf("go env answered %q", out)
	}
	return lines[0], lines[1], nil
}

// releaseNotices renders the notices for the verifier module at root.
func releaseNotices(root string) (string, error) {
	goroot, version, err := goEnv(root)
	if err != nil {
		return "", err
	}
	modules, err := compiledModules(root)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	out.WriteString("musai-verify compiles in the Go code below, each under the licence that follows its name.\n")
	goroots, err := readLicenceDir(goroot)
	if err != nil {
		return "", err
	}
	goLicence := goroots.alone("BSD-3-Clause")
	if goLicence == "" {
		return "", fmt.Errorf("the Go toolchain %s ships no licence text reading as BSD-3-Clause alone at %s", version, goroot)
	}
	goTexts := map[string]bool{goLicence: true}
	for _, path := range goroots.notices {
		goTexts[path] = true
	}
	goSection, err := section("Go "+version, map[string]bool{"BSD-3-Clause": true}, goTexts)
	if err != nil {
		return "", err
	}
	out.WriteString(goSection)
	paths := make([]string, 0, len(modules))
	for path := range modules {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	dirs := map[string]licenceDir{}
	for _, path := range paths {
		text, err := modules[path].noticesOf(dirs)
		if err != nil {
			return "", err
		}
		out.WriteString(text)
	}
	return out.String(), nil
}
