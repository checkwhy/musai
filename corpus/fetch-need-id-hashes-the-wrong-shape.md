# A fetch need's own id never agreed with the id its eventual receipt hashes to

The id a fetch need is tracked under was minted over the bare fetch recipe a contribution names —
a locator, declared headers and declared names. The citation the kernel actually stores for a
satisfied fetch need carries a different, run-shaped conversion of that same recipe: a `GET`
command naming the locator, the locator again as the recipe's own substrate. The two shapes hash
to two different ids, so a receipt already recorded for one fetch need — from a fold, or from a
fixture store on replay — could never be found by the id the need itself computed. Two rules
asking for the same body within one evaluation never deduplicated; the second silently refetched
rather than reusing what the first had already retrieved.

**Reproduces:** two rule invocations within one evaluation requesting the identical fetch need;
the second performs its own retrieval instead of reusing the first's already-recorded citation.

**Fixed by:** bbf9502 — Give a check with no code of its own an interpreter, and let a data-only
pack contribute one
