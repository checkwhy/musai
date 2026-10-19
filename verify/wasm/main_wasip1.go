//go:build wasip1

package main

import (
	"fmt"
	"io"
	"os"

	"github.com/checkwhy/musai/verify/internal/report"
)

// main reads a zipped or tarred bundle on stdin and the principal as its
// one argument, writes the report on stdout and exits with the verdict.
// It trusts the bundle's own allowed-signers.
func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: musai-verify.wasm <principal> < bundle.zip|bundle.tar.gz")
		os.Exit(report.Invocation)
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(report.Broken)
	}
	out, code, err := verify(data, os.Args[1], options{})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(code)
	}
	fmt.Println(out.Report)
	os.Exit(code)
}
