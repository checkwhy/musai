package check_test

import (
	"fmt"
	"io/fs"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/checkwhy/musai/verify/internal/canon"
	"github.com/checkwhy/musai/verify/internal/check"
	"github.com/checkwhy/musai/verify/internal/source"
	"github.com/checkwhy/musai/verify/internal/trust"
)

// put stores a record at the path its id names and returns the id.
func put(t *testing.T, fsys fstest.MapFS, kind, text string) string {
	t.Helper()
	id, canonical, err := canon.RecordID([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	hex := canon.Hex(id)
	fsys[fmt.Sprintf("records/%s/%s/%s/%s.json", kind, hex[:2], hex[2:4], hex)] = &fstest.MapFile{Data: canonical}
	return id
}

func run(t *testing.T, fsys fstest.MapFS) check.Result {
	t.Helper()
	src := &source.Source{Name: "test", Bundle: fsys, Trust: fsys, HasBlobs: fsys["blobs"] != nil}
	result, err := check.Run(src, table(t), trust.Own(src))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func hasCode(result check.Result, code string) bool {
	return slices.ContainsFunc(result.Findings, func(f check.Finding) bool { return f.Code == code })
}

func TestASourceWithNoRecordIsEmpty(t *testing.T) {
	result := run(t, fstest.MapFS{"allowed-signers": &fstest.MapFile{}})
	if !hasCode(result, "source.empty") || !result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestUnreadableRecordBytesAreAFindingNotAFailure(t *testing.T) {
	hex := "0000000000000000000000000000000000000000000000000000000000000000"
	for name, data := range map[string]string{
		"duplicate key": `{"kind":"rule","kind":"rule"}`,
		"invalid UTF-8": "{\"kind\":\"rule\",\"name\":\"\xff\"}",
		"not JSON":      "{",
		"no kind":       `{"name":"x"}`,
		"unknown kind":  `{"kind":"widget"}`,
	} {
		fsys := fstest.MapFS{"records/rule/00/00/" + hex + ".json": &fstest.MapFile{Data: []byte(data)}}
		if result := run(t, fsys); !hasCode(result, "record.unreadable") {
			t.Errorf("%s: findings %+v", name, result.Findings)
		}
	}
}

func TestAFileUnderRecordsThatIsNoRecordIsStray(t *testing.T) {
	fsys := fstest.MapFS{"records/notes.txt": &fstest.MapFile{Data: []byte("hi")}}
	put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	if result := run(t, fsys); !hasCode(result, "record.stray") || result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestARecordUnderTheWrongSecondPairIsAPathMismatch(t *testing.T) {
	fsys := fstest.MapFS{}
	id := put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	hex := canon.Hex(id)
	right := fmt.Sprintf("records/rule/%s/%s/%s.json", hex[:2], hex[2:4], hex)
	fsys[fmt.Sprintf("records/rule/%s/zz/%s.json", hex[:2], hex)] = fsys[right]
	delete(fsys, right)
	if result := run(t, fsys); !hasCode(result, "record.path-mismatch") || !result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestARecordOneLevelDeepIsStrayNotARecord(t *testing.T) {
	fsys := fstest.MapFS{}
	id := put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	hex := canon.Hex(id)
	put(t, fsys, "rule", `{"kind":"rule","name":"s","schemaVersion":1,"scope":{},"weight":"1"}`)
	right := fmt.Sprintf("records/rule/%s/%s/%s.json", hex[:2], hex[2:4], hex)
	fsys[fmt.Sprintf("records/rule/%s/%s.json", hex[:2], hex)] = fsys[right]
	delete(fsys, right)
	result := run(t, fsys)
	if !hasCode(result, "record.stray") || hasCode(result, "record.path-mismatch") {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestAReferenceToARecordOfAKindTheTableDoesNotAllowThereFails(t *testing.T) {
	fsys := fstest.MapFS{}
	rule := put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	put(t, fsys, "case", `{"claims":["`+rule+`"],"kind":"case","preset":{"contribution":"c","module":"m","moduleRecord":"`+rule+`"},"schemaVersion":2,"slug":"s"}`)
	result := run(t, fsys)
	if !hasCode(result, "ref.kind-mismatch") || !result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestAHeldBlobMustDigestToItsID(t *testing.T) {
	good := []byte("the bundle")
	goodID := canon.BlobID(good)
	missingID := canon.BlobID([]byte("never written"))
	for name, c := range map[string]struct {
		bundle string
		held   []byte
		want   string
		fails  bool
	}{
		"intact":   {goodID, good, "", false},
		"altered":  {goodID, []byte("the bundlE"), "blob.mismatch", true},
		"not held": {missingID, nil, "blob.absent", false},
	} {
		fsys := fstest.MapFS{"blobs": &fstest.MapFile{Mode: fs.ModeDir | 0o755}}
		if c.held != nil {
			hex := canon.Hex(c.bundle)
			fsys["blobs/"+hex[:2]+"/"+hex] = &fstest.MapFile{Data: c.held}
		}
		put(t, fsys, "module", `{"build":null,"bundle":"`+c.bundle+`","kind":"module","manifest":{},"name":"m","schemaVersion":1,"version":"1"}`)
		result := run(t, fsys)
		if c.want != "" && !hasCode(result, c.want) {
			t.Errorf("%s: findings %+v", name, result.Findings)
		}
		if result.Failed() != c.fails {
			t.Errorf("%s: failed=%v, want %v: %+v", name, result.Failed(), c.fails, result.Findings)
		}
	}
}

func TestABlobIsNotCheckedWhereTheSourceHoldsNone(t *testing.T) {
	fsys := fstest.MapFS{}
	put(t, fsys, "module", `{"build":null,"bundle":"`+canon.BlobID([]byte("x"))+`","kind":"module","manifest":{},"name":"m","schemaVersion":1,"version":"1"}`)
	if result := run(t, fsys); hasCode(result, "blob.absent") || result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestARunsOutputIsABlobOnlyWhereItsObservationSaysSo(t *testing.T) {
	output := canon.BlobID([]byte("output"))
	for storage, want := range map[string]bool{"blob": true, "inline": false} {
		fsys := fstest.MapFS{"blobs": &fstest.MapFile{Mode: fs.ModeDir | 0o755}}
		put(t, fsys, "run", `{"kind":"run","observation":{"output":"`+output+`","resolved":[{"annotations":{"storage":"`+storage+`"},"uri":"https://example.org"}]},"recipe":{},"runKind":"citation","schemaVersion":2}`)
		if got := hasCode(run(t, fsys), "blob.absent"); got != want {
			t.Errorf("storage %s: blob.absent=%v, want %v", storage, got, want)
		}
	}
}

func TestAnArtifactsReceiptAnchorMustResolveOnItsOwn(t *testing.T) {
	fsys := fstest.MapFS{}
	caseID := put(t, fsys, "case", `{"claims":[],"kind":"case","preset":{"contribution":"c","module":"m","moduleRecord":"`+canon.BlobID([]byte("pin"))+`"},"schemaVersion":2,"slug":"s"}`)
	anchored := canon.BlobID([]byte("a run nobody holds"))
	content := `# Draft\n\nA sentence[^` + canon.Hex(anchored)[:12] + `].\n\n## Receipts\n\n[^` + canon.Hex(anchored)[:12] + `]: ` + anchored
	put(t, fsys, "artifact", `{"case":"`+caseID+`","content":"`+content+`","format":"text/markdown","kind":"artifact","lifecycle":"drafted","schemaVersion":2,"supersedes":[]}`)
	result := run(t, fsys)
	found := slices.ContainsFunc(result.Findings, func(f check.Finding) bool {
		return f.Code == "ref.dangling" && f.At == "$.content"
	})
	if !found || !result.Failed() {
		t.Fatalf("an anchor to a record the source does not hold is not a dangling reference: %+v", result.Findings)
	}
}

func TestARunsReadSetIsFollowedByItsBareDigests(t *testing.T) {
	fsys := fstest.MapFS{}
	held := put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	missing := canon.BlobID([]byte("a record nobody holds"))
	put(t, fsys, "run", `{"kind":"run","observation":{"reads":[{"digest":{"sha256":"`+canon.Hex(held)+`"}},{"digest":{"sha256":"`+canon.Hex(missing)+`"}}]},"recipe":{},"runKind":"brief","schemaVersion":1}`)
	var absent []string
	for _, f := range run(t, fsys).Findings {
		if f.Code == "ref.pin-absent" && f.At == "$.observation.reads[*].digest.sha256" {
			absent = append(absent, f.Detail)
		}
	}
	if len(absent) != 1 || !strings.HasPrefix(absent[0], missing) {
		t.Fatalf("absent reads %v, want only %s", absent, missing)
	}
}

func TestARunsReadSetIsFollowedByTheDigestsItConsumed(t *testing.T) {
	fsys := fstest.MapFS{}
	held := put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	missing := canon.BlobID([]byte("a record nobody holds"))
	put(t, fsys, "run", `{"kind":"run","observation":{"reads":[{"consumed":{"sha256":"`+canon.Hex(held)+`"},"key":"slot:a"},{"consumed":{"sha256":"`+canon.Hex(missing)+`"},"key":"`+missing+`"}]},"recipe":{},"runKind":"brief","schemaVersion":3}`)
	var absent []string
	for _, f := range run(t, fsys).Findings {
		if f.Code == "ref.pin-absent" && f.At == "$.observation.reads[*].consumed.sha256" {
			absent = append(absent, f.Detail)
		}
	}
	if len(absent) != 1 || !strings.HasPrefix(absent[0], missing) {
		t.Fatalf("absent reads %v, want only %s", absent, missing)
	}
}

func TestAnAllowedSignersTimeWithoutAZoneIsWarnedAbout(t *testing.T) {
	fsys := fstest.MapFS{"allowed-signers": &fstest.MapFile{Data: []byte(`florin valid-after="20260101" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5` + "\n")}}
	put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
	result := run(t, fsys)
	found := slices.ContainsFunc(result.Findings, func(f check.Finding) bool {
		return f.Code == "trust.zoneless-time" && f.Severity == check.Warning && f.Path == "allowed-signers"
	})
	if !found || result.Failed() {
		t.Fatalf("findings %+v", result.Findings)
	}
}

func TestAStatementOutsideNFCIsRefusedWhileARunsBytesAreNot(t *testing.T) {
	decomposed := "café"
	for name, record := range map[string]struct {
		kind, text string
		want       bool
	}{
		"a claim's rendering":    {"claim", `{"kind":"claim","rendering":"` + decomposed + `"}`, true},
		"a dimension name":       {"rule", `{"kind":"rule","scope":{"` + decomposed + `":{"kind":"any"}}}`, true},
		"a principal":            {"run", `{"kind":"run","performer":{"kind":"foreign","principal":"` + decomposed + `"}}`, true},
		"a run's output":         {"run", `{"kind":"run","observation":{"output":"` + decomposed + `"},"recipe":{"command":["cat","` + decomposed + `"]}}`, false},
		"a claim already in NFC": {"claim", `{"kind":"claim","rendering":"café"}`, false},
	} {
		fsys := fstest.MapFS{}
		put(t, fsys, record.kind, record.text)
		if got := hasCode(run(t, fsys), "record.not-nfc"); got != record.want {
			t.Errorf("%s: record.not-nfc=%v, want %v", name, got, record.want)
		}
	}
}

func TestAnAllowedSignersLineNamingAnotherKeysFormIsAnErrorAndTrustsNothing(t *testing.T) {
	const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5"
	for name, line := range map[string]string{
		"another key's form":   "mallory,key:SHA256:y4ICVW80MG0xQMifgK91MGvkzy6PZDiva22Ln16p6vY " + key,
		"a malformed key form": "mallory,key:not-a-fingerprint " + key,
		"its own key":          "mallory,key:SHA256:xINMbtFxkELD0ccc0cxDBE87gG2aE/Yyt+W01EOwKpI " + key,
		"a name alone":         "mallory " + key,
	} {
		fsys := fstest.MapFS{"allowed-signers": &fstest.MapFile{Data: []byte(line + "\n")}}
		put(t, fsys, "rule", `{"kind":"rule","name":"r","schemaVersion":1,"scope":{},"weight":"1"}`)
		result := run(t, fsys)
		flagged := slices.ContainsFunc(result.Findings, func(f check.Finding) bool {
			return f.Code == "trust.key-mismatch" && f.Severity == check.Error && f.Path == "allowed-signers"
		})
		if want := strings.HasSuffix(name, "form"); flagged != want || result.Failed() != want {
			t.Errorf("%s: flagged %v, failed %v; findings %+v", name, flagged, result.Failed(), result.Findings)
		}
	}
}
