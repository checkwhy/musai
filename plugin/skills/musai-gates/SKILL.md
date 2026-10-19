---
name: musai-gates
description: This skill should be used when the user asks to "answer this gate", "what's still open on this case", "show me the pending gates", "rule on this claim", "decide this", or asks Musai to walk them through an open question a case is waiting on.
---

Find a case's own open questions and let the person at this conversation
answer one, without ever choosing on their behalf.

## Finding what is open

Call the `gate_pending` tool, optionally naming a case, to list the
gates still awaiting an answer — each one a claim, the case it belongs
to, and its gate class. Present that list; do not decide which one
matters most unless the person says so.

## Asking one gate

Call the `gate_ask` tool with the claim id to answer. Its answer carries
the brief's own rendered prose (`output`), the menu of options this gate
offers (`options`, each with its own `value` and `description`), and the
brief's own record id (`brief`). Present the brief's prose and the
options — each option's description, not just its value — as the menu a
person is about to answer. Nothing here is a verdict yet.

## Answering it

Call the `gate_answer` tool with exactly two fields: `pending` (the same
claim id `gate_ask` was called with) and `brief` (the id `gate_ask`
returned). Never pass a `choice`, a `via`, or a `principal` — this tool
accepts none of those, on purpose. Calling it opens a form in this
client that the person answers directly, choosing among the same
options the menu just showed; the model never sees or asserts their
choice before it is recorded. This is the person-class channel for a
gate answered in conversation — verified to render as a usable,
navigable menu in this client — so no redirect to a terminal is needed
here.

The call returns one of two shapes:

- An accepted answer: the ruling and its attestation, already minted.
  Report what was decided, in the option's own words.
- A non-answer: `{ answered: false, action, message }`, for a decline or
  an expired form. Report that the gate is still open and unchanged —
  never treat a non-answer as a ruling, and never retry silently.

## What this skill never does

It never presents a menu whose options it invented, never infers a
disposition from the conversation and calls `gate_answer` with a
pre-decided outcome, and never treats a decline or an expiry as an
answer. The decisive choice always comes from the person, through the
elicitation `gate_answer` itself issues.
