# A fetch resolution's own cache-lookup id never matched the citation it was meant to find

A moving reference's resolution computes a cache-lookup id over its own resolution method so a
second lookup within the resolution-age window can reuse an already-satisfied answer instead of
retrieving one again. For a run-shaped method this id is the run's own recipe, unchanged, which
is correct — a run's receipt carries that same recipe verbatim. For a fetch-shaped method the
lookup used the same bare-recipe id, but the citation a fetch resolution actually mints carries
the run-shaped conversion of that recipe, not the bare one — the identical shape mismatch already
found and fixed for a fetch need's own id, left unfixed at this second site. The lookup could
never hit, forcing a fresh retrieval on every resolution regardless of the resolution-age slot's
own configured value.

**Reproduces:** resolve the same fetch-shaped reference twice within one resolution-age window;
the second resolution retrieves again rather than reusing the first's citation.

**Fixed by:** 69a12d4 — Resolve a fetch need's own locator before its body is retrieved, and
prove the scaffolded template runs through every host locally
