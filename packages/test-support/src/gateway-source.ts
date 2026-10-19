export function gatewaySource(exportName: string, body: string, prelude = ""): string {
  // A throw in `body` propagates, so the host's own envelope catching answers it.
  return [
    prelude,
    `export function ${exportName}(requestBytes) {`,
    "  return (async () => {",
    "    const request = JSON.parse(new TextDecoder().decode(requestBytes));",
    "    const input = request.input;",
    "    const output = await (async () => {",
    body,
    "    })();",
    "    return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));",
    "  })();",
    "}",
  ].join("\n");
}
