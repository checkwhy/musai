export function invoke(_requestBytes: Uint8Array): Uint8Array {
  const value = Math.random();
  const output = { kind: "verdict", label: "open", reason: String(value) };
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}
