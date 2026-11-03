// Command notices prints the third-party notices a verifier release ships: Go's own licence and,
// for each module compiled into any target, the licence its compiled files fall under.
package main

import (
	"fmt"
	"os"
)

func main() {
	text, err := releaseNotices(".")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(text)
}
