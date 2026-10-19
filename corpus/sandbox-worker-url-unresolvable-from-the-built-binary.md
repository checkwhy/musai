# The in-process host's worker entry resolved relative to the wrong file once bundled

The in-process module host and the subprocess host each resolved a sibling build entry's own
output — the worker script, the child's own entry point — as a path relative to their own
file's `import.meta.url`. Under a test runner's own module transform, that file's own url sits
beside its sibling and the path resolves correctly by construction; once a bundler flattens the
containing file into a shared chunk at the output root, `import.meta.url` no longer sits beside
anything, and the same relative path resolves to a file that does not exist. Every invocation
through the in-process host failed once run from the built binary; nothing in the existing test
suite exercised this, since every test ran the module boundary against source, where the
resolution happened to be correct by accident of layout rather than by design.

**Reproduces:** build the kernel package, then drive `module new` / `module build` / `test`
against the built output — the in-process host fails every invocation that source-mode testing
never reached.

**Fixed by:** 332ff56 — Scaffold a new module that is already green, from a template that
cannot rot
