---
name: musai-status
description: This skill should be used when the user asks "what's the status of this case", "where does this case stand", "check a claim's status", "is this case done", "show me the case progress", or names a Musai case or claim and asks what it currently holds, fails, or is still open on.
---

Read where a case or a claim stands by calling the tool that already
computes the answer, never by working it out from the records directly.

## Reading a case's own progress

Call the `case_status` tool with the case's slug. Its answer names the
next pending gate in the case's own playbook order, or reports the case
done, along with the holds/fails/open tally across every claim the case
cites. Render exactly what the tool returns — the gate class, the
counts, whether the case is done — without adding a verdict of its own.

Where no MCP tool is reachable, shell to the equivalent CLI verb with
the JSON flag instead: `musai lab progress <case> --json`, and render its
output the same way.

## Reading one claim's own status

Call the `claim_status` tool with the claim's own record id. Its answer
is the claim's computed status — holds, fails, or open with a reason
from the closed reason vocabulary — exactly as the kernel's own
evaluator derived it. Present that status and its reason; never infer a
different one from the claim's rendering or its evidence.

Where no MCP tool is reachable: `musai status <claim> --json`.

## What this skill never does

It never computes a status, a verdict, or a hold/fails/open tally
itself — every number and every word in its answer comes from the tool
call's own output. A case or a claim this skill cannot resolve is
reported as the tool reported it, including a refusal's own reason, not
guessed at or smoothed over.
