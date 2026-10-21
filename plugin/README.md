# The Musai plugin

The Claude Code plugin shell: the conversational entry point into this
repository's own kernel, holding no logic of its own. Every skill is a
caller — it invokes an MCP tool or shells to a CLI verb with the JSON
flag, and renders what comes back. It never computes a status, a
verdict, or an answer.

## Installing it

From a checkout of this repository, add the plugin from its own path:

```
claude plugin marketplace add <this repository's path>
claude plugin install musai@<marketplace name>
```

Installing it starts the MCP server (`packages/distribution/dist/bin/mcp.js`) this
repository's own build already produces — build the workspace first
(`pnpm -r build`) so that entry point exists before a session starts.

## What ships today

- **The manifest and the MCP registration** (`.claude-plugin/plugin.json`, `.mcp.json`):
  installing the plugin is what starts the server the previous phases
  built.
- **`skills/musai-status`** — reads where a case or a claim stands,
  through the `case_status`/`claim_status` tools or the equivalent CLI
  verbs.
- **`skills/musai-gates`** — finds a case's open gates and lets the
  person at the conversation answer one, through the `gate_pending`,
  `gate_ask` and `gate_answer` tools. The person-class answer is the
  elicitation `gate_answer` itself issues — verified to render as a
  usable menu in this client — never a redirect to a terminal.
- **Two hooks**, in `hooks/hooks.json`: a `SessionStart` hook reporting
  what this machine has and needs (`doctor --json`), and a `Stop` hook
  for a turn ending on "the tests pass" with no receipt minted since the
  person's last message (`lab hook stop`): where the turn ran a test,
  lint or build command at the repository's root and it succeeded, it
  checks the claim by that command; otherwise it blocks once with the
  `musai check` that would.
- **`musai lab plugin sync`**: a module marks one of its own `template`
  contributions as a skill, and this verb writes it into
  `skills/<name>/SKILL.md` on the module's own install and update, so a
  pack can put a conversational entry in front of a person without
  writing outside this directory. Running it twice with nothing changed
  writes nothing; a module that no longer claims a name has its own
  synced skill removed; a skill this plugin ships by hand — this
  README, `musai-status`, `musai-gates` — is never touched by a sync.

## What does not ship yet, and why

- **`agents/`** — the crew (prosecutor, second reader, retro) arrives
  with its own phase. A directory with nothing behind it is a scaffold
  that reads as a capability nobody built.
- **`commands/`** — no slash command reaches anything a skill does not
  already reach; nothing here needs one yet.
- **A marketplace file** — distribution is a later concern; this phase
  installs the plugin from the repository's own path.
- **The funnel, retro and kind-drafting skills** — each waits on the
  phase that builds the operation behind it.
- **The `PreToolUse` hook** — the blindness predicate it would carry
  belongs to the phase that gives a reviewing agent something to be
  blind about.
- **The `SubagentStop` hook** — fires only for the crew, which is not
  here yet.

Every one of these is a documented decision, recorded in this phase's
own coverage matrix, not an oversight.

## A note on hook commands

Claude Code's own hook configuration runs a `command` field as a single
shell command string — there is no argument-array form in the schema
the installed client actually validates against. Both hooks here are
written as one portable command line with no shell operators (no pipe,
no `&&`, no chaining, no interposed script file): `node`, an absolute
path built from `$CLAUDE_PLUGIN_ROOT`, and a fixed argument list. That
is the closest a single required shell-command string can come to exec
form — never a second `.sh` file, which this project's platform
constraint rules out regardless of the field's own type.
