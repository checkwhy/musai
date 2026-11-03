package printable_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/checkwhy/musai/verify/internal/printable"
)

func TestEveryCaseInTheKernelsTableIsPrintedAsTheKernelPrintsIt(t *testing.T) {
	data, err := os.ReadFile("../../../conformance/printable.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Name    string `json:"name"`
			Text    string `json:"text"`
			Printed string `json:"printed"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table holds no case")
	}
	for _, c := range table.Cases {
		if got := printable.String(c.Text); got != c.Printed {
			t.Errorf("%s: String(%q) = %q, want %q", c.Name, c.Text, got, c.Printed)
		}
	}
}

// A byte that is not UTF-8 stays out of the shared table, as a JavaScript string cannot hold one.
func TestAByteThatIsNotUTF8IsEscapedAsItsValue(t *testing.T) {
	if got, want := printable.String("broken \xff byte"), `broken \xff byte`; got != want {
		t.Errorf("String(%q) = %q, want %q", "broken \xff byte", got, want)
	}
}
