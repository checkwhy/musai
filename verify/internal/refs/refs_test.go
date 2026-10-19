package refs_test

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"reflect"
	"testing"

	"github.com/checkwhy/musai/verify/internal/refs"
)

func TestTheEmbeddedTableIsTheConformanceTable(t *testing.T) {
	shared, err := os.ReadFile("../../../conformance/references.json")
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := os.ReadFile("references.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(shared, embedded) {
		t.Fatal("internal/refs/references.json differs from conformance/references.json: copy the shared table over it")
	}
}

func TestTheTableNamesEveryRecordKind(t *testing.T) {
	table, err := refs.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"claim", "argument", "run", "ruling", "rule", "case", "artifact", "attestation", "module"} {
		if _, ok := table.Kinds[kind]; !ok {
			t.Errorf("no table for %s", kind)
		}
	}
	if len(table.Kinds) != 9 {
		t.Errorf("%d kind tables, want 9", len(table.Kinds))
	}
}

func TestAnArrayIndexNormalisesToAStar(t *testing.T) {
	if got := refs.Normalise("$.evidence[12].run[0]"); got != "$.evidence[*].run[*]" {
		t.Fatalf("Normalise = %s", got)
	}
}

func TestClassifyReadsEachListOfTheTable(t *testing.T) {
	table, err := refs.Load()
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		kind, path string
		want       refs.Class
	}{
		{"claim", "$.evidence[*].run", refs.ClassReference},
		{"claim", "$.slot", refs.ClassNonReference},
		{"claim", "$.canonical.nested[*].deep", refs.ClassOpaque},
		{"claim", "$.canonicalish", refs.ClassUnlisted},
		{"module", "$.bundle", refs.ClassBlob},
		{"run", "$.recipe.command[*]", refs.ClassOpaque},
		{"artifact", "$.content", refs.ClassOpaque},
		{"rule", "$.name", refs.ClassUnlisted},
	}
	for _, c := range cases {
		if got := table.Kinds[c.kind].Classify(c.path); got != c.want {
			t.Errorf("%s %s: %v, want %v", c.kind, c.path, got, c.want)
		}
	}
}

func decode(t *testing.T, text string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestStringsVisitsEveryStringWithItsConcretePathInKeyOrder(t *testing.T) {
	var got []string
	refs.Strings(decode(t, `{"b":["x",{"c":"y"}],"a":"z","n":1}`), func(path, s string) {
		got = append(got, path+"="+s)
	})
	want := []string{"$.a=z", "$.b[0]=x", "$.b[1].c=y"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestAtReadsEveryValueAPathReaches(t *testing.T) {
	v := decode(t, `{"evidence":[{"run":"r1"},{"run":"r2"},{"item":"i"}],"over":{"claim":"c"}}`)
	if got := refs.At(v, "$.evidence[*].run"); !reflect.DeepEqual(got, []any{"r1", "r2"}) {
		t.Errorf("evidence runs: %v", got)
	}
	if got := refs.At(v, "$.over.claim"); !reflect.DeepEqual(got, []any{"c"}) {
		t.Errorf("over.claim: %v", got)
	}
	if got := refs.At(v, "$.claim"); len(got) != 0 {
		t.Errorf("an absent path reached %v", got)
	}
}

func TestReceiptAnchorsReadsOnlyTheTrailingReceiptsSection(t *testing.T) {
	const id = "sha256:946cb831732cdcf0a2fe465c7acb49e48fdb4015c92d7efc86ea930b4385e679"
	text := "# T\n\nBody[^946cb831732c] names [^000000000000]: sha256:" + "1111111111111111111111111111111111111111111111111111111111111111" +
		"\n\n## Receipts\n\n[^946cb831732c]: " + id + "\n[^aaaaaaaaaaaa]: not-an-id\n"
	got := refs.ReceiptAnchors(text)
	if !reflect.DeepEqual(got, []string{id}) {
		t.Fatalf("anchors %v, want [%s]", got, id)
	}
	if len(refs.ReceiptAnchors("no section [^946cb831732c]: "+id)) != 0 {
		t.Fatal("read an anchor outside a receipts section")
	}
}
