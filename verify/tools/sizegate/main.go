// Command sizegate prints each file's size and gzipped size and exits 1
// when any gzipped size passes the limit: the budget a page or a worker
// loads the verifier within.
package main

import (
	"compress/gzip"
	"flag"
	"fmt"
	"os"
)

func main() {
	limit := flag.Int64("limit", 3_000_000, "the most gzipped bytes a file may take")
	flag.Parse()
	over := false
	for _, path := range flag.Args() {
		size, gzipped, err := sizes(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		verdict := "within"
		if gzipped > *limit {
			verdict, over = "OVER", true
		}
		fmt.Printf("%-40s %10d bytes %10d gzipped  %s %d\n", path, size, gzipped, verdict, *limit)
	}
	if over {
		os.Exit(1)
	}
}

func sizes(path string) (int64, int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	counter := &counting{}
	zipper, err := gzip.NewWriterLevel(counter, gzip.BestCompression)
	if err != nil {
		return 0, 0, err
	}
	if _, err := zipper.Write(data); err != nil {
		return 0, 0, err
	}
	if err := zipper.Close(); err != nil {
		return 0, 0, err
	}
	return int64(len(data)), counter.n, nil
}

type counting struct{ n int64 }

func (c *counting) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return len(p), nil
}
