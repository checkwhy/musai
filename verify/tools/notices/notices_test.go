package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	mitText = "Permission is hereby granted, free of charge, to any person obtaining a copy\n" +
		"of this software and associated documentation files.\n"
	bsd3Text = "Redistribution and use in source and binary forms, with or without\nmodification, " +
		"are permitted.\nNeither the name of the holder may be used to endorse or promote products.\n"
	mplText = "Mozilla Public License Version 2.0\n==================================\n"
)

var releaseModules = []string{
	"github.com/ProtonMail/go-crypto",
	"github.com/alecthomas/kong",
	"github.com/cloudflare/circl",
	"github.com/cyphar/filepath-securejoin",
	"github.com/emirpasic/gods",
	"github.com/go-git/gcfg",
	"github.com/go-git/go-billy/v5",
	"github.com/go-git/go-git/v5",
	"github.com/hiddeco/sshsig",
	"github.com/jbenet/go-context",
	"github.com/klauspost/cpuid/v2",
	"github.com/pjbgf/sha1cd",
	"github.com/sergi/go-diff",
	"golang.org/x/crypto",
	"golang.org/x/net",
	"golang.org/x/sys",
	"golang.org/x/text",
	"gopkg.in/warnings.v0",
}

func TestTheReleaseNamesEveryCompiledModuleUnderAnAllowedLicenceAndShipsNoMozillaText(t *testing.T) {
	text, err := releaseNotices(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	var headed []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "==== ") && !strings.HasPrefix(line, "==== Go ") {
			headed = append(headed, strings.Fields(line)[1])
		}
	}
	if strings.Join(headed, "\n") != strings.Join(releaseModules, "\n") {
		t.Fatalf("the notices head these modules:\n%s", strings.Join(headed, "\n"))
	}
	if !regexp.MustCompile(`==== github\.com/cyphar/filepath-securejoin \S+ \(BSD-3-Clause\) ====`).MatchString(text) {
		t.Fatal("filepath-securejoin is not named under the BSD-3-Clause its compiled files declare")
	}
	if strings.Contains(text, "Mozilla Public License") {
		t.Fatal("the notices carry Mozilla Public License text")
	}
}

// moduleWith writes files, by path relative to a fresh module root, and gathers the .go ones.
func moduleWith(t *testing.T, files map[string]string) *module {
	t.Helper()
	dir := t.TempDir()
	m := &module{path: "example.com/m", version: "v1.0.0", dir: dir, files: map[string]bool{}}
	for rel, body := range files {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(rel, ".go") {
			m.files[path] = true
		}
	}
	return m
}

func TestRefusesAModuleWhoseCompiledFilesFallUnderALicenceOffTheAllowList(t *testing.T) {
	m := moduleWith(t, map[string]string{"LICENSE": mplText, "m.go": "package m\n"})
	_, err := m.noticesOf(map[string]licenceDir{})
	if err == nil || !strings.Contains(err.Error(), "example.com/m v1.0.0 compiles in m.go under MPL-2.0") {
		t.Fatalf("refused with %v", err)
	}
}

func TestASplitLicenceShipsOnlyTheTextTheCompiledFilesDeclare(t *testing.T) {
	m := moduleWith(t, map[string]string{
		"LICENSE.BSD":     bsd3Text,
		"LICENSE.MPL-2.0": mplText,
		"COPYING.md":      bsd3Text + mplText,
		"join.go":         "// SPDX-License-Identifier: BSD-3-Clause\npackage m\n",
	})
	text, err := m.noticesOf(map[string]licenceDir{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "(BSD-3-Clause) ====") || strings.Contains(text, "Mozilla") {
		t.Fatalf("the section reads:\n%s", text)
	}
}

func TestRefusesAFileUnderSeveralLicenceTextsThatNamesNoneInItsHeader(t *testing.T) {
	m := moduleWith(t, map[string]string{"LICENSE.BSD": bsd3Text, "LICENSE.MIT": mitText, "m.go": "package m\n"})
	_, err := m.noticesOf(map[string]licenceDir{})
	if err == nil || !strings.Contains(err.Error(), "m.go ships beside licence texts that do not read as one") {
		t.Fatalf("refused with %v", err)
	}
}

func TestAPackageTakesTheLicenceOfTheNearestDirectoryShippingOne(t *testing.T) {
	m := moduleWith(t, map[string]string{"LICENSE": bsd3Text, "sub/LICENSE": mitText, "sub/s.go": "package s\n"})
	text, err := m.noticesOf(map[string]licenceDir{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "(MIT) ====") || strings.Contains(text, "endorse") {
		t.Fatalf("the section reads:\n%s", text)
	}
}

func TestRefusesAHeaderNamingALicenceTheModuleShipsNoTextFor(t *testing.T) {
	m := moduleWith(t, map[string]string{"LICENSE": mitText, "m.go": "// SPDX-License-Identifier: ISC\npackage m\n"})
	_, err := m.noticesOf(map[string]licenceDir{})
	if err == nil || !strings.Contains(err.Error(), "m.go names ISC in its header, and its module ships no ISC text") {
		t.Fatalf("refused with %v", err)
	}
}

func TestRefusesAModuleShippingNoLicenceText(t *testing.T) {
	m := moduleWith(t, map[string]string{"README": "no licence here", "m.go": "package m\n"})
	_, err := m.noticesOf(map[string]licenceDir{})
	if err == nil || !strings.Contains(err.Error(), "m.go ships no licence text to give with its copy") {
		t.Fatalf("refused with %v", err)
	}
}

func TestOneTextReadingAsSeveralAllowedLicencesNamesEachOfThem(t *testing.T) {
	m := moduleWith(t, map[string]string{"LICENSE": bsd3Text + mitText, "m.go": "package m\n"})
	text, err := m.noticesOf(map[string]licenceDir{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "(BSD-3-Clause AND MIT) ====") {
		t.Fatalf("the section reads:\n%s", text)
	}
}

func TestRefusesOneTextReadingAsAnAllowedLicenceAndOneOffTheList(t *testing.T) {
	m := moduleWith(t, map[string]string{"COPYING": bsd3Text + mplText, "m.go": "package m\n"})
	_, err := m.noticesOf(map[string]licenceDir{})
	if err == nil || !strings.Contains(err.Error(), "compiles in m.go under MPL-2.0, which is off the allow-list") {
		t.Fatalf("refused with %v", err)
	}
}

func TestTheNoticesCoverEveryTargetTheReleaseBuilds(t *testing.T) {
	workflow, err := os.ReadFile(filepath.Join("..", "..", "..", ".github", "workflows", "verify-release.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var covered []string
	for _, target := range releaseTargets {
		covered = append(covered, target.goos+"/"+target.goarch)
	}
	matrix := "[" + strings.Join(covered, ", ") + "]"
	lines := strings.ReplaceAll(string(workflow), "\r\n", "\n")
	if !strings.Contains(lines, "\n          "+matrix+"\n") {
		t.Fatalf("the release workflow builds a matrix other than %s", matrix)
	}
}
