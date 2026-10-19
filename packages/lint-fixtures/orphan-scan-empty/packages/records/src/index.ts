// Bait for the orphan check: a production file that exports nothing, so the
// scan matches no exported declaration anywhere and proves nothing.
function local(text: string): string {
  return text.trim();
}

local("  a claim  ");
