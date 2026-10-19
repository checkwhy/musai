export function invoke(_requestBytes: Uint8Array): Uint8Array {
  const now = Date.now();
  const output = { kind: "verdict", label: "open", reason: String(now) };
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}
