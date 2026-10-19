//go:build js && wasm

package main

import (
	"fmt"
	"syscall/js"

	"github.com/checkwhy/musai/verify/internal/report"
)

func main() {
	js.Global().Set("musaiVerify", js.FuncOf(musaiVerify))
	select {}
}

const usage = "musaiVerify(archive: Uint8Array | ArrayBuffer, principal: string, options?: { trust?: string[], allowedSigners?: string })"

// musaiVerify(archive, principal, options?) answers
// { exitCode, report, summary } with the report as canonical JSON and the
// summary as { records, signatures, trust }, or { exitCode, error } where
// a command line would exit 2 or 1. The archive is a zip or a tar,
// gzipped or not. It never throws and never lets a panic out: a Go panic
// in a callback ends the whole runtime, not the call.
func musaiVerify(_ js.Value, args []js.Value) (answered any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			answered = map[string]any{"exitCode": report.Broken, "error": fmt.Sprint(recovered)}
		}
	}()
	refused := map[string]any{"exitCode": report.Invocation, "error": usage}
	if len(args) < 2 || args[1].Type() != js.TypeString {
		return refused
	}
	bytes := args[0]
	switch {
	case bytes.InstanceOf(js.Global().Get("ArrayBuffer")):
		bytes = js.Global().Get("Uint8Array").New(bytes)
	case !bytes.InstanceOf(js.Global().Get("Uint8Array")):
		return refused
	}
	opts, ok := optionsOf(args)
	if !ok {
		return refused
	}
	data := make([]byte, bytes.Get("length").Int())
	js.CopyBytesToGo(data, bytes)
	out, code, err := verify(data, args[1].String(), opts)
	if err != nil {
		return map[string]any{"exitCode": code, "error": err.Error()}
	}
	return map[string]any{
		"exitCode": code,
		"report":   out.Report,
		"summary":  map[string]any{"records": out.Records, "signatures": out.Signatures, "trust": out.Trust},
	}
}

// optionsOf reads the third argument, which may be absent or undefined;
// anything present must have the shape usage names.
func optionsOf(args []js.Value) (options, bool) {
	if len(args) < 3 || args[2].IsUndefined() {
		return options{}, true
	}
	given := args[2]
	if given.Type() != js.TypeObject {
		return options{}, false
	}
	var opts options
	if specs := given.Get("trust"); !specs.IsUndefined() {
		if !js.Global().Get("Array").Call("isArray", specs).Bool() {
			return options{}, false
		}
		for i := range specs.Length() {
			spec := specs.Index(i)
			if spec.Type() != js.TypeString {
				return options{}, false
			}
			opts.Trust = append(opts.Trust, spec.String())
		}
	}
	if text := given.Get("allowedSigners"); !text.IsUndefined() {
		if text.Type() != js.TypeString {
			return options{}, false
		}
		opts.AllowedSigners = []byte(text.String())
	}
	return opts, true
}
