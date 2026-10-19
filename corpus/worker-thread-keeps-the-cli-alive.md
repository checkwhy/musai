# A live worker thread kept the CLI process alive after its own work finished

The in-process module host starts and caches one worker thread per loaded module, reused across
invocations, with no method to release one. A live worker thread keeps the runtime's own event
loop non-empty indefinitely, so any process that used this host to run a module's own code
printed its result and then hung rather than exiting. Nothing in the existing test suite noticed,
since the test runner's own worker pool tears itself down regardless of what any one test left
running.

**Reproduces:** run a module's contribution through the in-process host from a plain CLI
invocation (not under a test runner) and observe that the process does not exit once its own
output has been printed.

**Fixed by:** 332ff56 — Scaffold a new module that is already green, from a template that
cannot rot
