# Musai

A framework for work whose result has to survive other people's judgment. A case goes on the
musai: a bug to report, a ticket to fix, a question to measure, a document to ship, a decision to
make, a scene to write. To get off it, the case has to make a set of claims good, and every claim
is either checked by running something or argued over by parties that never see each other's
reasoning, until it holds, fails, or a person rules. What leaves the machine carries its evidence.

Three properties hold everywhere. Nothing is decided without a person or a rule a person set.
Anything that stopped being true is found before it is filed. Every sentence in an artifact can be
traced to the run or the source that backs it.

The framework knows how to run work and nothing about any project. Everything that names a forge,
a repository, a person, a directory or a workflow is a module or a configuration written at
`musai init`.

## Words

**musai** — the queue of cases, and the record of each one.

**case** — one piece of work. It cites claims, its gates among them, owns its drafts and
artifacts, and is itself a record. It pins the ids it cited, and every reader of its claims reads
each as the record its slot now holds; a gate over a superseded record is not asked.

**kind** — what sort of case it is. A kind comes with a **setlist**: the claims a case of that kind
must make good before its artifact may go out, as a graph with gates in it.

**claim** — something a case says is true. "The fault reproduces on 6.4.1." "The test fails
without the fix." "The maintainers will accept this."

**check** — a claim settled by running something. The run decides; nobody argues. A claim is a
check when its own conditions name the rule that settles it: the condition key is the rule's
contribution id and its value carries that rule's parameters, so what settles the claim travels
inside the claim and a receiver re-runs the recipe and re-derives the verdict rather than taking
it on trust. Asking a claim's status performs the check — there is no separate verb for running
one — and the rule's conclusion enters the graph as an ordinary argument: a holding verdict speaks
for the claim, a failing one attacks it. Nothing is stored but the receipts the run mints.

**judgment** — a claim that can only be weighed. The only place people and agents argue.

**evidence** — what a claim rests on. **Receipts** are the captured output of something actually
run, with its exact conditions. **Citations** are a line in a document, a commit, a comment, at a
pinned version. Both are minted by the kernel; a rule can only request them.

**challenge** — a reason to think a claim is wrong. It carries a receipt or a citation of its own, or
it is dropped without an answer. A challenge may target a claim or a piece of evidence.

**answer** — the reply to a challenge.

**ruling** — a person, or a policy a person set, settling a question. A later ruling retires one by
naming it: a higher tier retires a lower; at the same tier, a principal retires its own ruling
where every principal attesting it is that one; and a person-tier ruling from a principal holding
`override-person` retires any, the only way to retire one nothing vouches for. Two peers who
disagree stay contested under a roles file; with none, every principal holds `override-person`.

**attestation** — the record that says who made, asserted, re-shared, released, sealed or revoked
another record, and when. The only record that is signed; it names its principal by key or by
pseudonym, never by a name.

**status** — every claim **holds**, **fails** or is **open**, with a reason and, for checks that
measure, a number. The kernel computes it from the record. Open is the only status that costs
anything: it is when an agent is spawned or a person is asked.

**weight** — some reasons outweigh others. A receipt beats a citation beats a person's judgment
beats an agent's; within a kind, the narrower rule beats the wider, then the declared weight
decides. Rulings sit above evidence. The **floor** beats everything and is never overridden.

**gate** — a claim a case cannot pass without a decision. Gates have a class: intent, judgment,
evidence, publish.

**conditions** — what a claim holds under, per dimension: a point, spelled as a bare string, or a
scope from the algebra — a span from one chapter until another, a set of platforms. Identity
dimensions are always points. Change one a rule read and the claim is **stale** until re-checked.

**lesson** — an accepted challenge promoted to a rule, so the next case is checked against it
without anyone remembering to.

**crew** — the agents a pack brings. **playbook** — what to do when a claim is open: whom to ask
next, in what order.

**pack** — a module carrying a kind, its setlist, its checks, its crew, its playbook, its presets,
and its **bookers** and **sinks**, the runs that bring cases in and carry artifacts out.

**preset** — a named bundle of settings for a run: which gates a person answers, which a delegate
may, budgets, signing, what may be finished unattended.

**why** — `musai why <claim>` walks from any sentence in an artifact down to the receipts.

Verbs, which read plainly and wink at anyone who has stood at a stage door: **book** a case,
**soundcheck** its claims, **drop** its artifact, **remix** a decision.

## Decisions

| Decision | Why |
| --- | --- |
| Arguments are the primitive; claims are their conclusions; status is computed | A thirty-year-old, well-solved problem replaces a hand-rolled ladder, and every pack gets the same guarantees |
| Checks are settled by execution; only judgments are argued | Agents spend tokens only where there is something to weigh |
| A kernel with no content; everything else is a module; `musai` is a distribution | First-party modules use the public API, so nothing is privileged except being preloaded, and a fourth case costs a pack rather than a core change |
| Modules speak one byte-level boundary, served by an in-process host and a subprocess host, with a WebAssembly host under Extism when a module from outside exists | The sandbox is a host, so isolation is a host swap and the development loop stays native; capabilities are the manifest; no native addon |
| Rules are pure functions that request runs they lack; bookers, sinks and sensors are runs too | Exact dependency tracking, safe memoisation, deterministic replay; every side effect has a receipt; the purity lint and the subprocess host enforce it |
| Git is the truth; SQLite is the index rebuilt from it | Every user has git; sharing is push, audit is log |
| Every record is immutable and named by its hash; one branch per scope | Two trees union without conflict, so lanes race on a ref swap, peers merge by fetching, one event is one commit, and a signature travels beside its record |
| A record is canonical JSON hashed to `sha256:<hex>`; provenance is an attestation record; signatures are sidecars in the signer's own format | `sha256sum` reproduces an id and `ssh-keygen -Y verify` checks a signature, so a stranger verifies with coreutils and OpenSSH; identical content from two people is one record twice attested |
| A run sees only the environment it declared; secret values are recorded as keyed hashes under a key that never enters git | Receipts are committed and shared, so nothing ambient may enter them, a fetched receipt reveals nothing about a secret, and a run's recipe is the same recipe on any machine while its observation records what the machine that ran it saw |
| Claims are shared and cited; cases own only their drafts and artifacts | One home per fact; a remix is a new case record and never a new claim |
| A claim is a typed record under a contract; the triple is the base type | Packs shape claims freely while every musai can index, sign-check, render and deduplicate them |
| Conditions are values in dimensions of a few core types, which modules instantiate | Version lines, timelines and hardware matrices order differently and federation still compares them |
| Authority is an explicit role matrix, shipped with defaults | Who may rule, set aside a run, publish or touch the floor is a permission, and alone every role is you |
| Presets are the configuration primitive | Autonomy, budgets and gates are slots an author fills and a user or the model picks, never fixed |
| TypeScript for the kernel and the surfaces | The MCP and Agent SDKs are first-class in it; one core serves the interactive and the headless surface |
| Federation over git remotes; SSH signatures locally, Sigstore for what is published; roles from two explicit files | Nothing is required to host, a stranger gets identity and tamper evidence without key exchange, and a role is always a line someone wrote |
| Its own funnel and retro | A stranger's install is whole |

## Architecture

```
                 surfaces        MCP server · CLI · GUI · Claude Code plugin shell · SDK driver
                 ───────────────────────────────────────────────────────────────────────
                 kernel          store · evaluator · scheduler · runner · fetcher · signer
                                 authority · events · module hosts · services
                 ───────────────────────────────────────────────────────────────────────
                 modules         dimensions · claim types · rules · kinds · roles ·
   (in-process or subprocess)    presets · crew · bookers · sinks · sensors · views
                 ───────────────────────────────────────────────────────────────────────
                 truth           .musai/  immutable records in git · index.sqlite rebuilt from them
```

Packages hold this in one dependency direction, enforced by a lint over the graph each package
declares. Kernel-side, bottom up: `records` (the canonical form, the nine kinds and their
declarations, the reason vocabulary, scopes, slots and their layering, dimensions, sealed values,
paths); `store` (the record and blob store interfaces, with git as the reference
backend); `trust` (attestations, sidecar signatures, roles and the matrix); `fold` (the SQLite
fold over a store's log — it imports the store as types only, so it never sees git); `run` (the
runner and fetcher); `modules` (the envelope, points, the hosts, manifests, install, the slot
registry); `evaluate` (labelling, rulings, staleness, the restart loop, `why`); `api-core` (the workspace
object, the operation registry — every verb a surface can call, declared the way a contribution
is, with an input and output schema, an effect class (read, write, performs, irreversible) and the
authority it needs — and the one `perform` that applies a plan); and `devkit` (module build,
scaffolding, the fixture runner), which is the only package that depends on a bundler. A
**distribution** is a package on top of those: `musai` holds the verbs and the distribution's own
semantics, the four gate-class names among them; the kernel sees a gate only as a claim that
admits nothing but a ruling, answerable by a policy of a declared class, and `intent`,
`judgment`, `evidence` and `publish` are the distribution's names for four values of that
property. The CLI and MCP packages are generic over a distribution and hold no logic of their
own; the `musai` binary is a binding of the musai distribution, and a second distribution
binds its own. The package and its binary are `musai`; this document writes a verb as
`musai <verb>`, after the distribution. Inside a package the directories are layered the same way and the lint pins the
order.

Two rules hold across every package. A shape closed by kernel role — the nine kinds, the verdict
pair, the attestation purposes — is validated by code, since those validators check what a schema
cannot say; a shape a module contributes is validated from the schema the module carried. And the
kernel holds no process-global state: everything a workspace knows — its store, its fold, its
trust, its claim types, its hosts, its clock — hangs off one workspace object a caller opens, so
two workspaces in one process share nothing and a long session refreshes rather than reopens.
Every timestamp a record carries comes from that clock and never from the machine's, since a plan
and the perform that applies it agree on a record id only if every instant between them came from
one source; a lint holds every read of the machine's clock to an argued allowlist.

### The kernel

Holds contracts and machinery, no content: no case kind, no pack, no domain vocabulary. What
it does fix is only what every musai must agree on for two of them to compare records at
all — the nine record kinds, the base triple, the four shipped roles, the reason vocabulary
and its exit-code classes.

- **Store.** Records in git and an index in SQLite. Nine record kinds, fixed: claim, argument,
  run, ruling, rule, case, artifact, attestation, module; evidence is an edge from a claim to a run with a
  selector. Only
  claim types are extensible. The fold holds every kind and is the read path: an operation reads
  rows, never trees, and a read by id is a lookup with no process spawned; the store's own
  primitive is the bytes git holds, which is what a signature is verified against. The store and
  the blob store are interfaces with git as the reference backend, and the round-trip proof is
  the conformance suite any other backend passes. One fold per scope, so a fork or a lane has its
  own and dropping a scope drops a file. A fork takes a copy of its base's fold and claims its ref
  at the commit that copy holds. A drop removes the fold before the ref, since a fold without its
  ref still answers while a ref without its fold refolds. A drop reclaims nothing: the scope's
  objects stay in the repository, and a branch at the tip the drop prints restores it. A merge is one single-parent commit on
  the target splicing in what the source holds and it lacks, a union the fold reads as if both
  scopes' records had been written there. A challenge is an argument
  attacking a claim or a run, an answer is an
  argument attacking a challenge, a gate is a claim whose class admits only a ruling, a lesson is a
  rule whose provenance is an accepted challenge; the words stay, the kernel sees the graph.
- **Evaluator.** Computes every claim's status with its justification, and what went stale: a
  claim whose latest evaluation read a key that holds something else now, found by a lookup in
  the fold's reverse index over every run's read-set rather than a scan. A claim read without
  performing answers from an evaluation nothing has moved under, with no rule invoked: the one its
  brief packs, by its rule's installed build, so where that build evaluated nothing it counts none.
- **Scheduler.** Decides what to compute next under budgets and concurrency, and when to park.
- **Runner and fetcher.** Musai's own performer of runs and fetches. Every receipt names who
  performed it, so a foreign tool's run is admitted under its own performer and trusted as far as
  that performer is, rather than being indistinguishable from one the kernel produced. A run request names
  the variables it needs; the runner starts from an empty environment and adds those, records the
  values of the plain ones and, for each one marked secret, a keyed hash under a workspace key that
  never enters git, so rotation is detectable here and the value is unguessable elsewhere; then it
  records the command, working directory, substrate digests, output and exit code. A fetched body
  that still carries text shaped like a credential once the declared secrets are scrubbed is
  refused, naming the shape and where it starts, never rewritten: the value is declared secret and
  the fetch run again. A fetch never follows a redirect: a response asking to move is refused
  before its body is read, since a body from anywhere but the declared locator is a
  citation whose subject nobody could reproduce, while a transport failure is still a receipt. A
  run under container isolation has networking off and mounts only its working directory,
  read-only, and a scratch, since a network the recipe cannot declare is a channel its receipt
  cannot describe, and its command's program replaces the image's entrypoint, so the command the
  receipt names is the one that ran; where no engine can hold the declared image, a cannot-hold policy of `ask`
  refuses at the runner, which has no one to ask. A binary a run finds on the host is tooling:
  declared by name, covered by an installed module's requirement or named among the workspace's
  tools for a check's recipe, and refused before anything spawns otherwise, and a receipt for a
  run naming it satisfies a need only while it is still covered; a binary under test is a
  substrate by digest or package url. The child's `PATH` is one scratch directory linking the
  declared programs alone, never the directories they sit in, so a run reaches nothing its
  receipt does not name. A container run keeps the `PATH` its image, pinned by digest, sets, since
  a host's directories name nothing inside it; its home, temporary and XDG directories are
  executable tmpfs mounts inside the container, never the host's scratch, where what an image's
  root writes would outlast the run, and a bound value reaches it by name from the engine's own
  environment, never in the engine's arguments, which any local user reads, so a name the engine's
  client itself reads (`DOCKER_*`, `CONTAINER_*`, `LD_*` and the like) is refused for such a run.
  The observation records what each name resolved to, so a receipt taken under
  hygiene is scoped to its host by its isolation level, and a re-run elsewhere is the same recipe
  with a new observation. A host run is its own session, with no terminal: its deadline ends the whole
  group, SIGTERM then SIGKILL after a short grace, and its caller's interruption sends the group
  SIGTERM, since a grandchild holding the run's output would otherwise hold the call and outlive
  it. A container run's deadline ends only the engine's client.
  Windows, which has no groups, ends the tree with `taskkill /T /F`. A checkout a run stands on is named in its recipe by commit, bound to a
  directory on this machine outside any record, and measured before anything spawns: a checkout
  whose tree is not the commit's, or a working directory that leaves it, by its spelling or through a symlink, is refused, and a receipt for the commit keeps satisfying after
  the checkout moves on, checked against the commit's tree rather than the disk. A working tree a
  run stands on is named in its recipe by name alone, bound to the top level of the repository
  the workspace sits in unless `checkouts.json` binds the name elsewhere, and
  measured before anything spawns as a checkout is, less the workspace directory, which holds the
  records a run writes and the blob store; its tree digest goes into the observation, never the recipe, so an uncommitted tree
  can be checked, its receipt names it by digest, a tree `git status` calls clean measures as its
  commit's, and the claim over it stays one claim across edits. The
  measurement reads the operator's own git configuration, so a checkout their `git status` calls
  clean measures as its commit. The store's git over a workspace's own repository, and a build's
  measurement of a module's tree, read none of the configuration, ignore or attributes files git
  takes by default from the operator's account or the system, and do read the measured repository's
  own files, its configuration, `info/exclude` and `info/attributes` among them, and any file that
  configuration names. A receipt is pinned, and has no age, when its recipe names at least
  one substrate and every one is a named commit — the one digest measured before a run stands on
  it — or a working tree that measures the digest the receipt recorded, declares no name, runs in a relative working directory inside the checkout, and every tool it
  recorded still resolves to the digest it recorded: running it again could differ only by what no
  input names. Of a recipe's receipts, the latest that still satisfies is reused, so a tree
  returned to what an earlier receipt measured reuses that one. A tree that measures as no
  receipt recorded re-runs the recipe, and read without performing it, the claim reads stale. The resolution age applies to everything else. Bookers, sinks
  and sensors are runs performed at their trigger, so a case's origin and an artifact's publication
  carry receipts like a test does.
- **Signer and authority.** Verifies sidecar signatures over attestation bytes against the
  allowed-signers file, evaluates the role matrix from the roles file, rejects what is invalid.
- **Events.** `claim.put`, `case.booked`, `ruling.made`, `run.recorded`, `attestation.made`,
  `module.installed`, `pin.changed`: one row per folded record of those kinds in the fold's own
  events table (an argument, a rule record and an artifact fold none, since no subscription asks
  for their events yet, and adding them is `events.since`'s next version), read forward by a cursor that names a commit and a position within it, so a
  rebuilt fold hands out the same cursors. Modules subscribe; after a write folds, the kernel
  dispatches the new rows to every subscription naming their event, and a subscription's answer
  is needs the kernel performs. A subscription's error answer, or a need of its run the kernel
  refuses, does not fail the write it followed: once the dispatch's receipts are folded, the
  surface that opened the workspace is handed it, the MCP server writing it to the session's call
  log and the command line to standard error. A surface's sink that throws refuses the call after
  the write landed, as a subscription that cannot be invoked does.
- **Module hosts.** Resolve modules from npm, git or a path; verify hashes; order by
  requirements; carry a subscription as a contribution like any other, so a sink is a run at its
  trigger rather than a hook the kernel activates; convert versioned types; fail closed with the
  module and version named; run the distribution's own modules in process and everything else in
  a subprocess host speaking the same envelope over a pipe; a Wasm host joins them when the first
  module from outside the distribution does. A run may reach for a program an installed module
  declares; a check's run may also reach for one the workspace's toolset, `config.json`'s `tools`,
  names, and every check recipe lists the whole toolset as tooling, so its receipt records each by
  digest. The kernel seeds no toolset, since no one set of programs is right on every platform and
  an unused one only unpins receipts. The first `check` naming a new program adds it there, on the
  trust branch, and says so, where its principal holds `configure-floor`, through any channel; a
  check admits only a program it resolves and then runs, so the run's receipt names what was
  admitted, and a station's check admits none, since the toolset is the author's to write. A module
  stays held to its own declarations. `lab config set <key> <value>` writes any other key of that
  file the kernel reads (`station.image`, `signing`, `floor`, `slots`, `declaredNames`,
  `blob.threshold` and `tools` whole) as a new commit that keeps another writer's keys, and `lab
  config get <key>` prints one, and `lab config unset <key>` removes a key as a new commit, writing
  nothing where it is absent. A value its key's own reader refuses, and a key none reads, is refused
  before anything is written. Setting and unsetting are a person's act: held to `configure-floor`,
  offered to no cleared surface, and refused through a model or any relayed channel, since a
  configuration write can change how every later verdict is judged (`floor`, `signing`,
  `station.image`) and its commit on the trust branch records no channel or principal class. A
  machine adds the programs its own launchers reach for in `.musai/local/tools.json`, never
  committed, since they vary with how a program was installed: each joins every run's PATH and its
  receipt by digest, never its recipe, so a claim's slot is the same on every machine, and `doctor`
  names them.

### Modules

A module exports a typed object of contributions the kernel can list, validate and document
without running it. A subscription is declarative, not an activation hook: a contribution naming
an event, which the kernel invokes with that event when it fires. The subscription is its own
handler: it answers with needs, and the kernel performs them.

A **contribution point** is itself data: a name, an input schema, an output schema and a role.
The role is closed by kernel role and has two values — `data`, for a contribution the kernel
reads from the fold and never invokes, and `invoke`, for one it calls through the envelope. The
kernel ships its own points as a table; a module may contribute a point of its own, which lands in
the fold like any contribution, and a contribution is installed only after its point. A kernel
seam consumes a kernel point; a pack's own point is consumed by other contributions through the
`invoke` need — a contribution asks the kernel to call another with an input, the kernel does so
and restarts the caller with the answer, and the call leaves a read-log entry naming the invoked
module, so re-pinning it makes every verdict that read through it stale. Contribution points:

| Point | A module may contribute |
| --- | --- |
| points | a contribution point of the module's own: name, input and output schema, role |
| dimension types and dimensions | orderings, hierarchies, expansion rules, purl oracles — data the kernel's comparison reads |
| claim types | a type, its identity dimensions, and an optional schema its canonical payload satisfies — data, never a function |
| expectations | a named predicate over evidence the declarative rule may invoke, beside the six the core module carries |
| folds and queries | a table as DDL plus a pure row function the kernel invokes per record and rebuilds with everything else; a read-only parameterised statement over declared tables, projected to `view.run` and to a tool |
| rules | checks that describe runs; judgments that brief an agent; weight and scope. A claim reaches the rule that settles it by naming its contribution id as a condition key. A rule record names the contribution whose policy it states, and a claim naming that contribution applies only where the current record's scope admits its conditions; a lesson's record names none and applies by scope alone. A claim naming two is refused until a real claim needs two; scope resolving which of several rules applies arrives with that claim |
| kinds | the claim graph a kind requires, with gate classes, and its playbook: whom to ask when a claim is open, in what order. A kind is invoked at booking, handed everything the booking knows, and answers with the claims a case must make good, naming the claim types they are of, which are contributions of their own — never with a slot, since only the kernel computes an id, and never with evidence, since what holds a claim up is found by evaluating it. The order it answers in is the order the case is worked through; whom to ask arrives with the crew |
| roles and actions | extensions to the authority matrix |
| presets | bundles of slot values |
| slots | a JSON schema, a default, and which layers may assign it |
| requirements | a tool the module's runs need: a binary by name with a version predicate, why it is needed and how to install it — `musai doctor` checks the list locally, showing a binary two modules declare under different predicates as one row that says a run naming it is refused, and a bundle carries it so a receiver prechecks before re-running. A workspace's toolset is its own requirements: `doctor` checks it, and a receiver prechecks it from the tooling each check recipe in a bundle names. A module record can reach the fold without install, so a requirement entry is checked against its point's schema where it is read, and a malformed one declares nothing and costs that entry alone, `doctor` naming its module and entry as a failed workspace row |
| templates | scaffolding `musai module new` picks up by name, for a data-only or coded module alike |
| subscriptions | an event name; the kernel invokes the subscription itself with the event when it fires, and performs the needs it answers with |
| crew | agent definitions: model, tools, brief |
| bookers, sinks, sensors | run descriptions: a command, a parser for its output, a trigger (book, drop, schedule), reversibility |
| views | renderers and briefs over a query's rows |
| operations | a verb: input and output schema, effect class, authority, and a handler that answers with a plan the kernel performs |

Ids are namespaced by module and a collision refuses to load. A module may be data only. A
**distribution** is a module with only requirements; `musai` preloads core dimensions, base
claim types, base roles, basic presets, the funnel, the retro, and the MCP and CLI surfaces.

On installation a module's manifest is stored as a record — a ninth kind, `module`, with the
manifest inline and the code bundle as a blob — so the store holds nine record kinds, a module's
identity is its content hash, the index lists its contributions without executing anything, and a
receiver gets a module from a bundle exactly the way it gets a claim. A module record supersedes
nothing: a name resolves to the record its latest commit wrote, so a re-pin is ordered by history,
and naming the replaced record would make an identical reinstall a different record and a new
commit.

A contributed declaration — a claim type, a dimension, a fold table, a query — that cannot stand
costs only its own contribution, and reading the set never throws, since a workspace
refused at open could be reached by no command. Two declarations of one claim type or one
dimension refuse every side, since picking a winner by byte order would be silently wrong where a
missing one is visibly absent; two fold tables rendering one name cost the later in fold order its
table. The fold remembers a row refusal only when the bundle alone answered it — an unknown
contribution, an invalid output, a throw — until a re-pin moves the module record, since nothing a
person can run takes a remembered refusal back; a failure the kernel, the host or the machine could
flip is retried at the next open. A query is bound to its declared tables by compiling it against a
scratch schema holding only those, which bounds its rows but not the catalogue: `sqlite_master` and
the pragma functions stay readable, since `bun:sqlite` lacks the authorizer that would close them
and a bound that holds under one engine only is no bound; parameters bind as `:name` for the same
reason. A query projected to `view.run` is handed only `kind` and answers case ids; the view
derives status and recency and owns filter and order, and a listing of anything but cases is
reached as a tool.

**Boundary and hosts.** A module talks to the kernel through one boundary: a request in, a
response out, both bytes, and no host calls as named functions — anything the kernel would have
exposed, such as a record by id, is passed in the input or requested, which is what lets a
zero-import module run on any host. The in-process host runs the modules the distribution ships
and the development loop; the subprocess host runs one in a process of its own over a pipe, and
the shipped packs pass CI through both, checked by behavioural equivalence on recorded read-logs.
A Wasm host is the third, arriving with the first module installed from outside: an Extism plugin
on the platform's own engine, the manifest its capability grant (`allowed_hosts`,
`allowed_paths`, memory limits, a hash per binary), every need a contribution returns a round the
kernel performs and records, and plugins in any language the PDKs compile. The developer kit
hides the build: `musai module new`, `musai module build`, `musai test` with recorded receipts
and a fake runner, golden renders. `module new` builds and tests apart from any workspace, and a
build is the one install, so `module build` is what puts a module in one. A manifest is derived, never declared: the build runs the
bundle once in a context with no loader, process, timer, clock or randomness and asks it to
describe itself, and the answer is the contribution table, with the package urls the bundler's
metadata names as the dependency list. A fixture suite is offline by construction: a need whose
recipe has no recorded receipt is refused rather than performed unless recording is asked for,
a recorded run naming a working tree stands in the module's own, measured less the receipts and
goldens recording writes, a
fixture input carrying an absolute path or this machine's host name is refused before it reaches a
contribution. The bundler's compiler options are part of a build's recipe,
strict among them: it reads no `tsconfig.json` or `jsconfig.json`, the module's own or one above it,
so where a module's source sits does not change how it is compiled, and a module whose imports all
resolve inside its tree builds to the same bytes from the same tree with the same bundler. The
hosts compile a module's source strict too, so the development loop runs what the build runs, save
one residual: the source path runs a module's top level on a global it then freezes, so a top-level
`var` or `function` is a property of that global and a write to it during an invocation throws,
where in the bundle it is a local of the bundle's own closure and the write works. A
build refuses a module whose bundle draws a file of its own from outside its directory, naming the
file: a file it reaches by path — a relative or an absolute import, a symlink, a pattern — or
through the package that holds it; a `?` or `#` suffix on the import places no file inside it. A
file drawn through a package the module imports by name, wherever a `node_modules` entry or a
workspace link resolves it, is recorded in the manifest by the package url of the nearest
`package.json` above it that names a package, and a package naming no version is refused. A file
no import reaches, as a package's pattern import matches, is held to the module's directory as its
own. A file of a package Yarn PnP keeps inside an archive is read by the nearest `package.json`
above the archive that names a package: where that one encloses the module, as a Yarn project's
root does, the file is held to the module's directory as its own, so the build refuses it wherever
the archive lies outside that directory; where it names another package, the file is recorded by
that package's url, as any package's file is; and where none above the archive names a package, the
build refuses it as underivable. That `package.json`, a Yarn PnP manifest above the module and the
bundler are the machine's.

**Nothing in a module performs I/O.** A rule receives evidence and returns a verdict, a request or
a conclusive error. A contribution lacking what it needs returns a list of needs rather than a
single request; the kernel performs each once per recipe per evaluation and restarts the
contribution from the beginning with every result folded in. The loop stops open at a stall: a
round whose needs this rule was already given, or an empty one; a need the
per-evaluation table already answered for another rule or round is still reused, but reuse alone
is not a stall. A booker, a sink or a sensor is a
subscription contribution the kernel runs at its trigger, never an activation hook the module
registers at load: an activation hook is a capability the envelope cannot describe, and a module
that can register behaviour at load is a module a receiver cannot audit from its manifest.

### Surfaces

A GUI is one more surface: it reads and writes through the same registry, over a local server it
starts or the MCP server, and holds no logic the command line lacks.

All of them are projections of the one operation registry a distribution declares, generic over
that distribution, and none holds logic of its own; where a piece of logic is bound to a transport
by nature — a gate answered through an MCP elicitation — the distribution ships it as an extension
the generic surface mounts, so the exception is visible rather than smuggled. The generic MCP server
hands an extension tool the session's context as it was built, beside the sinks that log a
subscription's trace and, once per session, each file the fold left out of the index: it adds no channel or principal,
so one that attests anything establishes its own. It validates the call's arguments against the
tool's own input schema, refusing `invalid-input` before the tool is reached (a tool whose schema
does not compile is refused `tool-unavailable` by its name, and its siblings serve), so `plan` and
`expectHead`, which a projected call strips, are refused by a tool that does not declare them, and writes the call
to the session's log as it does a projected tool's. An operation that
writes returns the records it minted, ids and bodies, so a
surface never assembles a commit; one asked in plan mode returns what it would mint without
writing a record (a salted draft may create the workspace key, so the ids it shows are the ids
written), which is where an irreversible gate's preview comes from, and a verb with nothing to
preview refuses plan mode by name rather than performing under it; one that needs a decision
returns a pending record another operation answers. Events are a cursor a caller reads forward,
never a push, and the MCP server's own list-changed notification is derived from that cursor
rather than a mechanism of its own; a session whose scope is dropped under it refuses every tool call, tool
list, resource read and prompt `workspace-incomplete`, naming the drop, until the scope is made again. An operation is named `id@version`, and every answer is
checked against its output schema, which a reader holds it to, so an output that gains a field, or a
field that comes to count something else, is the operation's next version. An operation is declared by any module: its
handler answers with a plan — records to put,
attestations to make, needs to perform first — which a pack's answers across the module boundary,
where the kernel checks its shape on either host and passes each record it drafts through the
admission that record's kind gets from the distribution's own verb, which the distribution hands the
surface — a case draft carrying the `about`
its booking was made with, so the kernel derives its setlist from the kind rather than taking the
pack's word for it, and a claim draft naming no slot given the one its type and conditions compute,
as a booking's claims are, so a pack drafts a claim without hashing anything — and the kernel's one
`perform` applies it under
the descriptor's declared authority, checked by the kernel and never by the pack; the channel enters
a plan from the context the surface established and the principal from the key the call signs
with, the same principal the authority is checked against, never from an input, so a
pack's operation cannot assert a person's ruling, and an irreversible effect from a pack is
refused unless a project slot allows it. A pack's draft supersedes nothing, save an artifact
standing in for one artifact of its own case, and carries no sealed text; the kernel refuses both
before any distribution's admission runs: retiring a record reaches it forward out of the
rulings, the contributors and the arguments the fold weighs, and that is an act its own verb asks
authority for; and the key that could open a sealed value lives on this machine, so a value a
pack hands over was sealed under no key the workspace holds, and nothing that reads the record
could read it. A pack drafts no run, attestation, module record, rule record or ruling: the kernel
alone mints a run, an attestation or a module record, nothing mints a rule record, and a ruling is
a person's act, minted by a distribution's own verb under its authority check. The module
boundary's plan schema refuses a plan putting any of these kinds first, on either host, and the
kernel's pass refuses each again, before any distribution's admission runs, as the guard for a plan
that never crossed a host; both read the kinds a pack may put off each kind's contract, its
`packMayDraft`, so the kernel names no kind. A distribution's admission, not the kernel, must
refuse a pack's case under a slug the store already holds, which would re-pin the booked case, and
its claim naming another exclusive group at a slot already spoken for, which would leave every read
of the slot refused; musai's refuses both through its own verbs' checks. Every evidence edge a pack's drafted record cites is re-admitted by the kernel before any
distribution's admission runs, as `challenge.file`'s own edge is: the cited run's attestation
verified where the signing level requires it, the selector's parser run over the run's own
observation, and the item it names compared with the edge's. What an edge says a receipt says is
decided at admission or never, so no distribution can let a pack's claim rest on an edge whose
item its selector does not admit over a run the store holds, or on a run the pack wrote itself.
The distribution's own tooling verbs may also drive a kernel primitive — a worktree, a key file, a build — which a pack may not. Before any
pack ships a kind, a bare `book` mints a case citing one base triple claim per `about` URI it is
given — enough to exercise the operation contract end to end. A booking naming a kind mints that
kind's setlist instead, and the case records which kind it was booked under.

- **MCP server**, a core module, started with the session. Tools are typed: `case_book`,
  `claim_status`, `gate_pending`, `gate_ask`, `gate_answer`, `challenge_file`,
  `ruling_make`, `brief_render`, `claim_why`. It lists the CLI's public verbs alone unless started
  with `--lab`, as the plugin starts it, so a stranger's agent meets the same words. Resources: `case://<slug>`, `claim://<slot>`,
  `gates://pending`. Modules add tools, prompts and resources at runtime through it, so the
  Claude Code plugin directory is a thin shell — mechanically: a contribution kind whose own
  declared input is an object schema (never the boolean shorthand a kind nothing invokes
  repurposes the field for) projects to a tool from that schema directly, an `operation`
  contribution among them, its answer a plan the kernel applies; a `template` contribution
  projects to a prompt the same way. A refusal the kernel names answers as a tool result,
  `isError` with the canonical `{ reason, about, detail }` and no `structuredContent`, since MCP
  gives a failed call a result of its own and a client validates structured content against the
  tool's output schema; so the reason, which the class follows from, crosses the transport. A throw no reason names
  is a defect and stays a JSON-RPC error, as does a session's own pre-call check. A resource read and
  a prompt have no error result, so a refusal of either crosses as a JSON-RPC error whose `data`
  is that same object; any other failure of one is a bare JSON-RPC error.
  A session's own call log is local, envelope-shaped and never a record. It scrubs a secret it
  can recognise — a string equal to a known binding's value, replaced by the keyed hash a
  receipt would carry, or by the binding's name alone before the workspace has a key, since a
  passive log mints none — but it does not scan free text, so a secret a caller concatenated into
  a longer argument survives in it verbatim. That is tolerable only while the log stays on the
  machine that wrote it: a call log is secret-bearing, and any surface that would export,
  attach or display one must either scrub beyond equality or require an explicit release, the
  same posture export attestation takes for a record.
- **Claude Code plugin.** Skills for the conversational entry, the funnel, the retro and kind
  drafting; hooks on `SessionStart`, `PreToolUse`, `Stop` and `SubagentStop` that call the
  engine, the `PreToolUse` one also refusing reads under `.musai/` when `agent_type` names a
  reviewing agent; agents for the crew. A module that needs Claude Code to invoke a skill on its own marks
  it, and `musai plugin sync` writes that file into the plugin on install and update.
  Ships now: the manifest, the MCP registration, the two conversational-entry skills (case and
  claim status; finding and answering a gate), and `SessionStart`/`Stop` hooks calling `doctor`
  and the stop check. The stop check reads a turn whose last message says tests, a build or lint
  pass and that minted no receipt since the person last wrote. Where the turn ran a check the
  sentence rests on (a checker such as `vitest` or `tsc`, or a runner's `test`, `lint`, `build`,
  `typecheck` or `check`), in the foreground at the repository's root, its result came back as no
  error, and checking it adds no program to the workspace's tools, the check mints the claim through
  `check`, which runs it again in its declared environment under a deadline below the hook's
  timeout, and blocks once if it does not hold. Otherwise it blocks once naming the `check` that
  would make one, with `--replace` where another command already checks the sentence: a refused
  call writes a result too, so only one's coming back as no error counts as having run, and a
  command naming no check is never run for the turn. It never blocks twice running. It reads Claude
  Code's session transcript, whose line shape is Claude Code's own and unpublished, so a change
  there breaks the check, and its test pins the shape it reads. A GitHub Action in the repository re-runs a
  committed workspace's checks and posts one Check Run, holding only `checks: write`. Arrives with the crew's own phase: the funnel, retro and kind-drafting skills, the
  `PreToolUse` blindness hook and the `SubagentStop` hook, and every agent — a directory nothing
  yet has something behind it is not scaffolded empty in the meantime.
- **CLI.** For people and hooks, the whole design's verbs; which ship in v1 is a scope decision
  made elsewhere. Eight are public: `init`, `check`, `status`, `why`, `render`, `export`, `rerun`,
  `doctor`, so a stranger meets claim, receipt, holds, fails, stale and why before any other word;
  the rest sit under `lab`. `check "<sentence>" -- <cmd>` mints a claim whose conditions name the
  core module's declarative rule over a recipe running `<cmd>`, then performs it as `status` does.
  `check "<sentence>" --rule <module>/<rule> [--parameters <s>]` mints the same claim naming an
  installed module's rule instead, `<s>` its condition's value, so a module's own rule judges a
  claim with no kind around it; a sentence moved between the two forms is a successor at its slot.
  `export <id> --to <audience>` mints the closure release it ships when none stands; `release` and
  `revoke`, under `lab`, set terms and withdraw. An export carries `allowed-signers` and `roles`
  cut to the principals whose signatures it holds, and never `config.json`, a writer's policy no
  verifier reads.
  A check claim cites no run, so its export also carries the runs that decide it and each run of
  the same recipes that read the same tree and binaries, each under a record release of its own;
  a module rule's are the runs its evaluations read, and its module record, build receipt and code
  travel beside them, as a module's do where it decides an expectation the interpreter invokes, or
  `export` names the rule a receiver cannot re-derive. An applicable check its rule's installed
  build has not evaluated has no runs that decide it, so `export` refuses it, naming the `status`
  that evaluates it.
  `rerun <bundle|url>` checks a stranger's bundle as the verifier does, prints the recipe it would
  perform and the tree it would read, and performs it only with `--yes`, in a scratch workspace
  over this checkout, writing nothing to the receiver's own; a check's run matches its receipt when
  its exit code does, the check's finer verdict, and beside that comparison `rerun` names each
  side's verdict, holds or fails, and whether they agree, so a failure that changed its code reads
  differs with both failing; output that moved is named beside it. It
  reads every claim the bundle carries, whatever its type: one a module's rule judges, or the
  interpreter by anything but one recipe's exit code, matches when its rule reaches the same verdict
  over the runs performed here as over the bundle's receipts; with no module or no verdict to
  re-derive, as where a module that stays home decides an expectation, `rerun` names the rule not
  re-derivable there, and a module that came without its build by name, as `export` named it, and
  exits as unheld. Over MCP the person at the client confirms
  through elicitation before `rerun` performs, whoever passed `yes`.
  `init`, `book`, `list`, `status`, `progress`, `log`, `soundcheck`, `ask`,
  `pending`, `answer`, `rule`, `why`, `brief`, `open`, `save`, `diff`, `remix`, `drop`, `remote`, `run`,
  `module`, `test`, `plugin`, `doctor`, `key`, `release`, `revoke`, `export`, `check`, `render`, `rerun`. `progress` is a case's own progress — the next
  pending gate in playbook order, or that it is done — kept apart from `status`, a single claim's,
  since the two answer different questions and `status` was already spoken for. A case is done
  when it cites a claim and each one holds or fails only as a menu member its holding sibling
  settled; otherwise it is open, saying why: it cites no claim, a claim is open, a check reads
  stale, a check has not run here, or a claim fails. Its counts take a menu once: by the member
  chosen, each other member counted as **not chosen** rather than failing, or, where nobody has
  chosen, as one open claim. `list` reads that same derivation from recorded receipts, performing
  nothing, so a check whose inputs moved reads stale there and one nothing has run reads
  unchecked, rather than judged.
  A verb groups under its noun only when the noun has a verb family of its own — `module new`,
  `module test`, `module build`, since `new`, `test` and `build` are generic and mean nothing
  without the noun beside them; a verb unique in the whole design stays bare — `status`, `answer`,
  `why` — because the noun would only add length, never meaning. The test is whether the bare verb
  reads unambiguously across the design, not whether its noun happens to have other verbs.
  The case is the surface's own implied noun, and supplies it wherever a verb serves one: `book`,
  `open`, `save`, `answer`, `why`, `progress`, `list` and `pending` all read against the cases the
  workspace holds, so `musai lab list` lists them and needs no noun spelled beside it. Every other
  noun spells itself — `module`, `key` — which is why a second `list` under one of those groups
  rather than competing for the bare spelling.
- **SDK driver.** `musai run [--preset overnight] [--until gate|drop] [--lanes N]` drives the
  same kernel through the Agent SDK, each lane a session, the same crew, the same tools served
  in-process. Subscription login works.

**Gates.** In a conversation the skill puts the question as a menu with a description per option
and records the answer. From a command or the CLI the engine asks through an elicitation: the
options as an enum with display names, the reasoning in the message, a free-text field. Both
produce the same commit, because both call the one answering operation; the attestation records
the channel the answer came through, and an answer a model relays is the delegate's ruling,
provisional and flagged, whatever the surface asserts. So is an answer from a command line with no
terminal attached — a script, a hook, an agent's own shell — which records the `process` channel.
A person-class ruling comes through an elicitation the client renders, an interactive terminal, or
a signature. The terminal is the weakest of the three, since an agent can allocate one for itself,
so it serves a person working at their own machine and nothing a stranger relies on: publishing, a
release, and overriding a person's ruling take a signature, which a receiver can check and a model
cannot forge. A GUI signs a person's ruling with their key, so it arrives as a signature.

**The machine contract.** Every verb renders text for a person by default and, under `--json`,
prints the operation's output in the canonical form, so two runs at the same head are byte-equal
and a hook can hash them. Why a thing did not happen — an open status, a refusal, a brief's
omission — is one closed vocabulary: a reason is deprecated, never removed or renumbered, so a
receiver reading an old refusal in a bundle still resolves it. Every refusal the kernel raises
carries a reason from that vocabulary and so its class; a failure with no reason is class 1 by
rule, and a stack is shown only when asked for. Exit codes name the caller's next
move, one per class, and `musai doctor` prints the table:

| Exit | The caller's next move |
| --- | --- |
| 0 | nothing — it worked |
| 1 | report a bug — the kernel itself failed |
| 2 | fix the invocation |
| 3 | fix the workspace |
| 4 | re-fold and retry — the head moved |
| 5 | ask someone with the role |
| 6 | install something |
| 7 | read the report — a claim fails, is stale or is open, or a module's own test does not hold |

`doctor` exits 3 when a row about the workspace fails; a row about the machine, such as the
canary or the container engine, is routine to fail and never sets its exit, and neither does a
requirement row, a conflicted pair included, since the run it refuses reports it by name.

### Proof

Three layers, each with a job. Unit tests pin one organ. Contract tests run every verb in-process
through the one entry point every surface uses, and three conformance suites — store backends,
index providers, hosts — are parameterised over the implementation they are handed, so a second
one runs the same file. Scenarios run journeys through the built binary against a workspace the
binary itself made: a directory each, its fixture packs, a script of invocations, and the
recorded bytes of every answer, ending with the fold deleted and rebuilt byte for byte, `why`
walked to a receipt for every claim that holds, and the whole thing run twice. A capability is
done when a scenario exercises it through the binary; an export with no production caller fails
the lint, so a limb cannot be left hanging quietly.

## The model

**A claim** is a typed record honouring one contract, whatever shape a pack gives it:

- `type`, versioned: `bugs.reproduces@2`.
- `about`: URIs of what the claim concerns. The cross-pack join key.
- `slot`: the identity key, computed by the kernel from the identity dimensions the claim's type
  declares; a kind answers with none, and a claim a pack's plan drafts names none or the one its
  type and conditions compute. Two records with one slot are
  one claim; the engine merges by it and conflicts only on it, and a contributor some later record
  supersedes neither speaks for the slot nor lends it evidence.
- `conditions`: per dimension, a value from the shared vocabulary — a point spelled as a bare
  string, or a scope. Identity dimensions are points, since a slot computed from a span would put
  one claim in many places at once.
- `canonical`: the bytes hashed and signed.
- `rendering`: one sentence a person can read without the pack.
- `evidence`: run hashes, each with a selector.
- `supersedes`: the records this one replaces, empty where it replaces none.

The triple (subject, predicate, object, plus conditions) is the base type and satisfies the
contract trivially. Similarity is a pluggable identity strategy a pack may add; identity stays
exact by slot and similarity is advisory. A base module ships common claim types (reproduces,
cites, passes, accepted-by, decided-by, measured) so packs extend rather than reinvent.

**Runs** are receipts and citations: what was executed or fetched, under which conditions, of
which kind (run, citation, testimony, brief). A run names its **performer** — musai's runner with
the kernel version it ran, a module's contribution, or a foreign tool under the principal standing
behind it — and asserts its **determinism**: deterministic, seeded, or neither. Determinism is what
the performer asserts about re-running, not a property the recipe could carry, so it sits on the
record and a recipe's id never depends on it; a seeded run's seed needs no field of its own, since
a recipe holds the literal command and the literal environment it was given. A run record splits into a **recipe** — the command, the
tools it reaches for beyond it by name, the literal environment, the declared names bound from elsewhere, the substrates by locator and
digest, and the isolation level asked for, with no path from any one machine in it — and an
**observation**: what this machine saw when it performed that recipe, including the substrates and
binaries actually resolved, the isolation level that actually held, the captured output, what the
run **cost** where anyone measured it — CPU, tokens, money, as exact strings, an absent field
meaning unmeasured rather than zero — and how the run ended. A deterministic run carries no instant,
so its id is its content and a stranger's re-run mints the same record. A plain binding's recorded value
names no path of this machine either: a path under the run's working root is recorded as
`./<path>`, one under a root the caller names, such as a tool's package, as `<root>:<path>`,
and a run binding any other absolute path is refused; a helper is recorded by its program's name.
What still ties a receipt to a machine is the binaries it resolved, by digest, which is what ran;
a container run resolves none on the host, since its image's digest, a substrate, fixes every program
inside it. It also records what the run read beyond its recipe and its bindings — nothing, for
a command or a fetch, whose every input is declared or bound; every record it was shown or asked
for, for a testimony run, so a judgment goes stale by the same trace a check does. Each entry of that
read-set carries the key it read, a claim's slot, a run or fetch need's recipe (the need asks
for its latest receipt, so a receipt landing later moves it) or else a record id, and the digest
of the bytes it consumed, so a change's reach is a lookup and a reader whose consumed bytes did not move is skipped
rather than staled. A testimony run
— an agent or a person asked something — is a run of the same shape: the crew definition and the
brief it was given as substrates by digest, the model as a moving reference resolved at the call,
the credential a declared secret, the transcript as the output, and the answer and the usage read
from it by parsers. A brief run is what a decider was shown: rendered from the store's head, the
case and a byte budget, all named in its recipe beside the kernel version that rendered it and
the clearance it was rendered under where one is set, reading exactly the records whose bytes it
carries (each it packed, and each argument whose reason it quotes, standing against the claim or
a run it rests on: one it cites, or for a check each receipt of its latest evaluation at that head,
by its rule's build installed there, that holds) and writing the rendered bytes as its output,
so a receiver re-renders it byte-for-byte, a ruling's evidence is its read-set, and a seal on
anything it quotes withholds it.
It does not read the evaluation that chose a check's receipts, whose bytes it carries none of: a
later one holding on the same receipts moves nothing, and one on others moves the receipts. A
station and its author each evaluate under their own recipe, so a ruling is held to the receipts
of the clearance its brief was rendered under, whoever reads it. Its budget trims what is not
pinned weakest first, an argument whole, and names each omission.
A rule's evaluation is a run of its own kind, its
reads in that same shape, so the dependency fold reads one shape for every derived thing and a
verdict is a receipt a stranger re-runs. An evaluation's
read-set is what the kernel handed its rule: the claim under its slot, each evidence run, each
record asked for and each invoked contribution's module. A rule is handed each record it asks for, a
claim as it stands at its slot whichever of its ids was asked, so a successor reaches the rule and
its reads alike. A performed evaluation is minted only where it read or
concluded otherwise than the claim's latest, which it supersedes, so a repeated status mints
nothing; it lands in one commit with every receipt its loop performed, so no reader holds those
receipts before the evaluation reading them. A host that dies or a rule answering what no rule may
concludes the check open, so that evaluation carries them; a loop that throws instead lands what it
performed alone, in its own commit, so nothing it paid for is lost. A station shown those receipts
while their claim is sealed alone therefore sees a commit that also holds something withheld from
it: that something landed there, never what. A brief and an evaluation are
**computed** by the kernel rather than performed in an environment: always deterministic, their
recipe is a command over substrates and their observation the output, the read-set and the cost,
with no environment, binary, exit code or instant to fill with a placeholder. The recipe's own id is what a need, a satisfaction and a citation key on; the
observation is what a second machine's re-run of the same recipe differs on. Every record kind
carries an integer `schemaVersion`, so a later widening of a kind's shape is a version bump rather
than a one-way rewrite of every id that already cites it: a record declaring an older version is
normalised into the current shape as it is read and keeps the id its bytes digest to, and a
signature made over those bytes still verifies. A kind's normaliser maps each older version
straight to the current shape, and a bump rewrites every entry rather than chaining them, so one
place says what an old record becomes. Only a record at the current version must digest back to
its id once validated; an older one keeps its bytes' id and loses any field outside its contract,
since refusing it would lose the whole record rather than the field. Every record kind also
names the records it
**supersedes**. A correction, a set-aside, a retraction is a successor rather than an edit; the
fold reads the current record and reaches the ones behind it forward, which is provenance and not
the revocation a revoked attestation carries. **Evidence** is an edge from a claim to a
run with a selector, so one suite run backs many claims. **Arguments** attack: a challenge
attacks a claim or a run, an answer attacks a challenge. A challenge carries exactly one piece
of evidence: two reasons to doubt something are two challenges, each answerable on its own. An
argument also names its
**premises** — the claims it rests on, conjunctively, so a premise that stops holding is itself an
attack on everything built over it. **Rulings** carry the verdict they
reached, the reason and the brief that asked the question — the evidence they saw is the brief's
read-set, one home for the fact — while who ruled, when and through which channel live on the
attestation that signs it, and whether the ruling was within authority is evaluated from the
roles file, never stored, and so is whether a ruling's retirement was. A ruling names its
**extent**: one claim, or a type at a scope — the
second a policy, bearing on every claim of that type whose conditions the scope contains, decided
once rather than repeated per claim. A **gate** is a claim of a class that admits only a ruling, with
the policy that may answer it, so a ruling alone decides a gate no evidence reaches, and `why`
names that ruling, never a receipt, as what decided it; a menu is a set of sibling gate claims declared mutually
exclusive, closed by the commit that opens it, so no later claim joins it. A member holds only when
it applies and its own rulings resolve `holds`, which settles the siblings as failed, so a person's
`fails` over a delegate's answer reopens the menu; a member that does not apply settles nothing for
its group and is offered by no menu, and a ruling on a claim that does not apply is refused, since
nothing about it is decided; a second ruling that would make two hold is refused. **Rules** are records: a module seeds its own at load, and the retro
writes a lesson as a rule whose provenance is the accepted challenge. A rule record names the
contribution whose policy it states; a lesson's names none. **Cases** cite claims and own
drafts, artifacts, a preset, and edges to other cases (spawned, after, fixture, remixed from), and
pin the evaluator version they were booked under: a kernel whose version later disagrees is a
moved reference, going stale through the same machinery rather than being refused. A remix is an
edge and never a supersession — both timelines stay and both answer — while a case that supersedes
another replaces a booking that should no longer be read as current.
**Artifacts** have a lifecycle: drafted, dropped, retracted; an artifact names the format its
bytes are written in and the drafts it supersedes — a list, so a draft that resolves a fork
closes it — and its sentences anchor to the claims and runs they rest on through footnotes
resolved in its own receipts section, so a published artifact carries its evidence.
**Attestations** are the only records
that put a signature behind a principal: each says that a principal, at a time, through a named
channel, made, asserted, re-shared, released, sealed or revoked the record it points at, and its
signature sits beside it. A run's foreign performer names the principal standing behind it and
attests nothing, which is why a receipt is trusted as far as its performer is and no further. An
attestation's principal is a key, `key:SHA256:<fingerprint>` as `ssh-keygen -l` prints it, or a
pseudonym. A name is an alias the allowed-signers file lists beside a key, shown by `why` and
`trace` and deciding nothing, and no surface takes the machine's user name or an MCP client's
for one. Identical content
from two people is one record with two attestations, which is how agreement and contest both show.
A claim, an argument, a ruling, a case or an artifact may carry a **salt**, which the kernel mints
when its writer asks (`--salt`, `salt` over MCP and on a plan's draft) and never takes from a
caller: a keyed hash under the workspace's current key over the record without it, or, under a
clearance, under a key derived from that key and the clearance, so a station's salted guess never
takes the id of the author's record and the kernel is no oracle for it. It is deterministic, so a
plan and the perform after it mint one id, and two writers in one workspace, or two stations of
one clearance, salting the same record still agree; it cannot be computed without the key, so
whoever lacks the key cannot confirm a guess at the record by hashing it. A rotation of the
workspace key changes the salt the same record gets, so drafts salted either side of it carry
different ids and do not agree, while the records salted before it stand as they are. Both costs
are accepted: identical content salted in two workspaces is two records, so agreement by content
stops at the workspace, and a key rotation changes every salted id minted after it. A `check`
asking for a salt where an unsalted claim holds its slot mints the salted claim as its successor,
and a case booked with or without a salt is not booked again the other way. A pack's case names
the claims it drafts beside it by their unsalted derivation, which it can compute, and the kernel
cites the salted id of each one it drafts salted, whether or not the case asks for a salt. A record
arriving whole, merged, pulled or seeded from a bundle, keeps its bytes, salt included, and one
seeded is refused where they carry a field its kind did not allow at the version they declare, a
salt among them before its kind knew one. An unsalted record keeps its identity by content, and a
run, a rule, an attestation or a module is never salted: a run's id is what a re-run agrees on.

## Status

For each claim, in order:

1. **Applicability.** A rule, ruling or lesson applies under the claim's conditions or it does not.
   Binary, decided first.
2. **Evidence kind.** Receipt, citation, person's judgment, agent's judgment. Fixed in the kernel,
   read from the run's kind and the class of the principal on its attestation. A derived claim takes the weakest link of its chain: a receipt that rests on an agent's guess
   counts as a guess.
3. **Specificity, then weight.** Within a kind, the narrower scope wins; scopes neither of which
   contains the other count as equal; among equals, the declared weight; among equals again, two
   arguments that both support the claim corroborate it, `status` counting and `why` listing every
   one beside the first, and only a support meeting a defeat is left open.
4. **Rulings** sit above evidence, ordered by authority then time. A ruling that conflicts with a
   receipt is a **set-aside**: it must challenge the receipt with a reason, the run stays in the
   graph, `why` shows who overruled it, and the retro counts it.
5. **The floor** is strict and changes only by a configuration commit.

A challenge that wins against a run removes the support and leaves the claim open; a challenge
that wins against the claim makes it fail; a cycle of attacks leaves every claim in it open.
Validity is separate from weight: an unsigned ruling where signing is required, an unknown type,
or an out-of-scope condition is rejected or inapplicable, never "light". A claim of an
unregistered type is refused when written, since its slot cannot be recomputed without the
declaration, and admitted when read back from git, for the evaluator to find inapplicable. Nothing
is counted; quorum exists only as a check with a measure. Status ships with the comparison that
decided it.

A claim resting on a secret whose bound value has moved reads stale. Reading status resolves only
bindings the local file gives literally and never runs a credential helper, since a passive
read must not spawn; where the bindings or the workspace key cannot be read, the value reads as
moved.

Under the hood this is grounded argumentation semantics with rule preferences, and a rule whose
inputs moved is stale by verifying traces. Whoever wants the theory finds it at the end.

## Conditions

A condition is a value in a named **dimension**. A dimension's name carries no `/`, and a
dimension or claim type declaring one is refused: a condition key with a `/` names a module's
contribution, such as the rule reading its parameters from it. The kernel knows five dimension
**types**:
totally ordered, DAG, hierarchical categorical, interval, identity-only. Modules instantiate
them: a version line as a DAG of package URLs with a semver oracle (`pkg:docker/example/server@…`,
`pkg:maven/org.postgresql/postgresql@42.7.13`, `pkg:github/example/server@d4e66f1f`), a story
timeline as a DAG of hours whose days expand to their hours, a platform as a hierarchy
where linux covers ubuntu. `any` is universal. Moving targets such as a nightly resolve to a
concrete value at check time and a sensor watches the pointer. A dimension names its order from a
closed list the kernel implements, lexicographic and numeric among them, rather than shipping a
comparison, which is code and could not travel as contribution data.

**Scopes**, what a rule or ruling applies under, come from a closed algebra: point, from, until,
range, set, except, any. Containment is computable, so specificity is. All of it is data: a pack
that needs a decision the algebra cannot express contributes a **coded** scope, which is a
reference to a module contribution rather than a function — so a scope canonicalises and travels
in a record like any other value. The kernel resolves the reference through the module; it applies
or not and is never narrower than anything. Comparison is four-way, so
incomparable is never read as equal, and where an order cannot place a value the
algebra takes the sound answer: an exclusion that might reach a span is treated as reaching it, so
a policy never applies where its author carved it out. A DAG may name coarse values that are no
node of it, such as a day, each spanning a first and a last node: as a lower bound a coarse value
reads as its first node, as an upper bound or as a value asked about as its last, so a day's range
holds every hour of it and a bare day is its last hour. A module spells them in its `dag`
dimension as `expansions`, a map from each coarse value to its first and last node. A record spells each meaning one way: a
point is a bare string and never an object, every scope bound is a string, since the number policy
does not walk conditions and a bound `2.10` would otherwise hash as `2.1`, and a scope is rebuilt
from its known fields as it is read, so a stray field cannot give one meaning a second id.

**Identity** dimensions are declared per claim type and form the slot. Every receipt records the
full context regardless. What a rule actually read decides staleness. Instability under identical
identity is the signal that a context dimension should be promoted, and promoting one is a new
version of the claim type with a migration.

## Authority

A **role matrix** per pack grants actions to roles: `rule`, `set-aside`, `publish`,
`override-person`, `configure-floor`. Shipped roles: owner (whoever booked the case), maintainer
(over acceptance claims about their project, as the roles file grants it), arbiter (settles
contested rulings), delegate (an agent; `rule` only). Who holds a role is two of the three trust files on `main`: the
allowed-signers file, in git's own format, binds a key with a validity window to its own form and
to the name shown beside it, `<name>,key:SHA256:<fingerprint>`, so `ssh-keygen -Y verify -I` checks
the key a record names; a line listing another key's form is refused, since one key never speaks
as another. The roles file grants a principal, a key or a pseudonym, roles at scopes. `init --key`
registers the operator, the key's line in allowed-signers under the name `MUSAI_PRINCIPAL` gives,
or under its own form alone where none is given, and the key's form `owner any` in roles, so a workspace's releases count; with no key both stay
empty, every role is anyone's and nothing is written. A call holding no key attests as the
pseudonym `MUSAI_PRINCIPAL` takes under the workspace key, and with neither is refused, naming
both. A workspace registered before keeps its records; a key whose line lists only a name is
refused with the line to put in its place, and no trust file is rewritten for it. A principal matches an allowed-signers entry exactly; OpenSSH's wildcard and negation
forms are not implemented rather than approximated. A signature is verified at its attestation's
own claimed time, so a key rotated out of its window later never invalidates history it signed
while valid.

Among rulings: person, then policy, then delegate. The tier a ruling may take comes from the roles
file, never from its record: person and policy need a role granting `set-aside`, delegate one
granting `rule`, and a principal attested as an agent rules only as delegate. A ruling nothing
vouches for, or one the matrix does not grant its principal, decides nothing and leaves its claim
open as "contested-authority", never falling back on the evidence alone, though a claim that does
not apply keeps its own reason; a grant revoked after the ruling was made reads the same way, as
outside authority rather than malformed, since it is a fact about today's roles file. A **policy**
is a standing ruling over a claim type at a scope, standing behind a principal. A ruling is **pinned** to the evidence it saw; when that evidence moves,
the ruling stands for its snapshot and the dependent gate is flagged "decided on stale evidence":
it stays answered with the ruling's verdict, every reader agrees that it does (`status` carries the
flag, `pending` and `progress` list the gate as flagged), and the person may re-affirm it or
supersede it. A claim whose own check's tree moved has no current receipt and reads open as stale.
Equal authority in conflict is open with reason "contested-authority" and gated to the arbiter.

A ruling is corrected by a later ruling on the same claim that names it in `supersedes`, and `why`
still reaches it from its successor. A higher tier retires a lower; its own principal, where every
attestation behind it is that principal's, retires it at the same tier; retiring a peer's ruling,
or one nothing vouches for, takes a person-tier ruling from a principal holding `override-person`,
the arbiter or the owner, so under a roles file a disagreement between peers stays contested until
the arbiter or the owner settles it. A succession counts only when the successor is a ruling on the
same claim, the name is a ruling on that claim and not a policy, the succession was within that
authority, and of the successions that meet all three it is the first to land (a later one is a
fork); any other retires nothing, so a correction of a name whose succession did not count still
can. Ships now: every reader weighs a succession through that whole rule in one kernel helper, and
the mint's check is the writer's early refusal, so a tenant's own verbs or a peer's store inherit
the rule rather than calling it. How a policy retires arrives with the first writer of policies.

## Presets

Every setting that varies by run is a **slot**: each gate's policy (person, policy, delegate,
pre-answered, explore), the stand-in, rehearsal, the finish line, budgets, signing level,
staleness policy, concurrency, release audience, trust classes, advisory thresholds. A slot is a
**contribution** a module declares — a JSON schema its value must satisfy, a default and the
layers permitted to assign it — so the kernel holds no setting of its own: its own slots are
declared by the preloaded core module, and a receiver holding a bundle lists every slot and its
default from the module records in it without running anything. A preset is a **data
contribution** assigning slot values by id; layering is pack defaults, project, preset,
per-booking. The case records the preset and overrides, so `why` can say "delegate, because
preset overnight": it stores the layers it was booked under — the commit of `main` its project
configuration was read at, the preset, the overrides — and never an effective value, which could
disagree with the layers that produced it. A pack author ships presets with the workflow; a
project and a person add their own; the model may choose one when the ask implies it, and the choice is recorded.

Shipped: `bare`, the booking default, which assigns no slot; `interactive`, where an isolation
level that cannot be held becomes a question and a resolution lasts a day; and `ci`, where it
refuses before anything spawns and every resolution is fresh. None yet sets who answers a gate.
Designed, not yet built: `overnight` (bounded delegate at judgment gates, intent gates
pre-answered or parked, rehearsal off, local artifacts finished, drops parked) and `explore`
(fork the top options as timelines and choose among results in the morning).

## Autonomy

Gates have classes: **intent** (a person, before or at the gate), **judgment** (delegable within
bounds), **evidence** (a policy may answer), **publish** (a person unless a policy explicitly
grants it). A **delegate** rules provisionally; every such ruling is flagged and listed, and
reversing one in the morning recomputes only what depended on it. **Budgets** per case and per
run stop spawning at the cap and park cleanly with reason "over-budget". An irreversible sink is
never delegable. A **rehearsal** is optional: before booking, the funnel walks the gates a kind is
known to raise, framed hypothetically, and records pre-answers scoped to the case. The **night
report** is a query: what was decided provisionally, what parked and why, what was produced,
what it cost. The retro reads the reversal rate per gate type.

## Truth in git

`musai init [workspace]` creates `<workspace>/.musai/`, the current directory's when none is
named, a git repository holding only the framework's own records. Project repositories never see it.

```
main                         config, project modules, allowed signers, roles, audiences
scope/<name>                 the records of one scope: a project, a world, a workspace
view/<slug>                  a case materialised for reading, rebuilt like the index
```

**Records** are files under `records/<kind>/<xx>/<yy>/<hash>.json`, `xx` and `yy` being the hash's
first and second pair of hex characters, two levels so that a directory stays small however large a
scope grows: every commit rewrites whole the directories it touches, and the fold compares each one
entry by entry. A scope written one level deep is rewritten by `musai lab store relayout`,
commit by commit under the same ids, its old history kept at `refs/one-level/scope/<scope>`. Each is named by the hash of its canonical bytes, written
once and never edited: a retraction, a supersession, a new lifecycle state of an artifact is a new
record pointing at the old one. Two trees of records union without conflict, and every
other property rests on that. A commit adds records and swaps the scope's ref by compare-and-swap;
a lane that loses the swap re-reads and retries, and no lane needs a working tree. Git's own
collection is off, since an object is written before any ref reaches it; past 6,700 loose objects,
git's own default, a write packs the store and prunes nothing, and `doctor` shows the count. The swap
settles which commit lands, never whether two writers agreed: a check made against the fold before
it saw an older tip, so two packs whose declarations collide can both land, which costs less than a
lost write, since the collision is refused when the declarations are read. A write carrying an
expected head reads the tip once and is refused as `head-moved` on a mismatch, never retried,
since a retry would apply a decision made against one head to records its maker never saw. A case
is a record; a **remix** is a case record naming its parent and the gate it forked at, both timelines
stay, and `musai diff` between them is the retro. Commits carry trailers — `Musai-Event` on
every write, `Musai-Claim` naming the claims when a write includes one, and `Musai-Order` naming
its records in the order they were written — so `git log` reads as the event log. The fold reads
`Musai-Order` back and positions a commit's records by it: path order is id order, and a run's id
digests the binaries it resolved, so path order would differ between machines. A merge names its
source's records in the order the source wrote them; a commit naming no order keeps path order.
The store is four operations, put record, read bytes, swap ref, and a log of what each commit
changed, with git as the reference backend; the fold consumes the log and nothing else.

**Form.** A record's bytes are its JSON in the canonical form of RFC 8785: sorted keys, no
whitespace, ES6 number formatting, so exact decimals and integers beyond 2^53 travel as strings and
a measured double stays a number. Its id is `sha256:<hex>` of those bytes, the file at
`records/<kind>/<xx>/<yy>/<hex>.json` holds exactly them, and the type and version of the record are inside.
The bytes of three kinds are the format a second implementation reads, and they freeze: the claim,
the run and the attestation, in this canonical form under its number policy, with principals named
one way, an attestation from version 6 by key or pseudonym and one minted earlier by the name it
was minted under, and a salt as an optional field. A string at a path the reference table lists as a
statement (a claim's sentence, canonical form, `about` and conditions, a slug, a dimension name or
value in a scope, a principal, an audience) is in Unicode NFC: the kernel refuses one that is not
rather than rewriting it, and so does a verifier (`record.not-nfc`), while the surfaces compose what
a person types. A string a record holds as data, a run's recipe and observation, a reason or an
artifact's content, keeps its bytes, since a rerun has to reproduce them. The `$sealed` key below
stays reserved outside that format. A later version of a frozen kind may add an optional field or
a value a field did not take before, and nothing else: it never removes or renames a field, changes
one's type or meaning, or makes an optional one required, and a record keeps the version it was
minted at and is read as minted. `conformance/frozen.json` holds a record of each frozen kind at its
version, which the kernel mints and a verifier reads byte for byte. A verifier extends trust only for
meanings it knows: a release or a seal of a version later than it reads counts for nothing, and its
report names it skipped, with its version. Every other kind, and the kernel
around them, keeps changing for the packs.
References are ids, so a ruling's snapshot commits to the exact evidence it saw. A payload too large
for a record is a blob, a git object on the store's `blobs` branch at `<xx>/<hex>`, hashed raw,
referenced by id, travelling with every clone, deletable from the branch's tip and never from
history once pushed. The canonical form reserves exactly one key: a value written
`{ "$sealed": { alg, keyId, ciphertext, digest } }` may stand where a claim's rendering, an
argument's or a ruling's reason, a run's output or an artifact's content would, and is refused
anywhere else. The canonicaliser is blind to it, so the id is taken over the ciphertext and a
receiver who cannot open it can still check the bytes are the ones that were signed; sealing, keys
and unsealing are a later version's. A principal may be a pseudonym, `pseudonym:<key id>:<keyed
hash of a name>` under the workspace key, which a surface holding no signing key mints for the name
it was launched under; it is that workspace key's, so a rotated key or another clone mints
another, and the matrix grants roles to it exactly as to a key.
A record carries no visibility of its own: it is exported whole
while a standing release attestation names an audience for it and withheld whole otherwise, so
nothing leaves until someone signs for it and a later attestation can take it back; a pack that
needs a public half and a private half writes two records that reference each other. A release
names an **audience**, an **extent** and **terms**. The extent is the record alone or its
closure, one attestation either way, since what a record cites is fixed by its id. The terms say
whether the bytes travel or only the id, which uses are granted (review, cite, republish, the last
only under an `spdx:` licence), a window, and a marking a receiver already reads, such as
`tlp:amber`. A **revocation** names, in `supersedes`, the exact releases it withdraws.
Audiences nest, `peer` within `known` within `public`, and a revocation withdraws only the class
it names: a record released to `public` still reaches peers, so pulling it back revokes the widest
release that stands. A release, like a seal, is a person's: it is refused through a model, an
export through one mints none, and one relayed through a model counts for nothing. A release
stands while it counts, signed by a principal holding `publish`, and no counting revocation or
later release supersedes it; a revocation counts when a principal holding `publish` or the
release's own signer signed it. Nothing compares the attestations' `at`, which each signer
asserts: a forward-dated release cannot outrun a revocation, and releases and revocations from
many lanes or remotes merge as a two-phase set. A record derived from others carries an
**audience label** the fold computes from its read-set, never a field of the record, so the
labelling rule can change while records stand; widening it is a `released` attestation, signed and
revoked as any release is.

A release decides what leaves the machine; a **seal** decides what a station inside it sees. A seal
is an attestation, purpose `sealed`, naming one record and `seal: { audience, extent }`; the extent,
as a release's, is the record alone or its closure (`seal --closure`, as `release --closure`), and
the record alone is written by naming none, never `record`, so one meaning has one id. Sealing
from an audience at another extent supersedes the seal from it that stands. A seal stands as a
release does, signed by a holder of `publish`, and is refused through a model, as a release is. A
revocation lifts it: the verb withdraws releases or lifts seals, never both in one call, though a
revocation naming both counts for both; one relayed through a model lifts no seal. A record is
sealed from a clearance where a standing seal over it, or a closure seal over a record whose
closure holds it as a release's would (cited, or a receipt of a check claim's recipe) through any
chain the cleared fold's position holds, names that clearance, an audience covering it or an
audience it covers, so a seal from `cast` hides from `cast`, from what `cast` includes
and from `public`, and reaches no audience beside `cast` either way; a run is sealed
with anything it consumed, a record with what it supersedes, and an attestation with its subject,
unless a standing release over it covers the clearance; a bare citation is not a read, so a case
citing a sealed claim stays and lists the rest, and a claim citing a sealed run is judged on the
rest of its evidence, while an argument citing one, or a ruling whose brief is withheld, stays and
contests the claim on grounds the station is not shown, so the claim, and every option of a menu
so ruled, reads open, never holding on what the station cannot see; a brief there packs such an
argument by its reason alone, pinned against any budget, saying it contests on withheld grounds;
a menu so ruled is not pending there, nor its case's next gate, and a ruling made there is weighed
against every vouched ruling, so a station never rules a second option into holding. A closure seal over a check
claim withholds every receipt of its recipes, more than its export ships: each carries the recipe
the sealed claim names, and which ones read the deciding tree moves as later runs land, so a
narrower set would show a station sealed evidence once the check runs again; a condition that
does not read withholds the receipts of each recipe it does name, of those its cited runs ran and
of those its evaluations read, so only the receipts of a recipe it names in no form the kernel
reads, cites no run of and no evaluation reads stay visible.
What its evaluations read is judged in log order: a receipt is judged at the later of the earliest
standing closure seal's commit and its own, and withheld where the sealed claim and an evaluation of
it reading its recipe had both landed by then, so neither an evaluation nor a closure member a
station cannot see withdraws a receipt it holds, and none an evaluation's own loop performed is ever
shown, since those land in its commit. Where the sealed closure holds a claim a module's rule
judges, a receipt landing from the later of that seal's commit and the claim's landing that nothing
in its own commit reads is withheld too, as a failed loop's receipts land alone and name no claim,
so a station's own standalone receipts are withheld from it there. Lifting the earliest of several
seals judges again from the next one's commit, as that seal landing alone would. Receipts landed
apart before the seal, by a subscription, a plan's needs or `rerun`, stay shown though a later
evaluation reuses them. A
**clearance** is fixed when a surface starts, `--clearance` for the MCP server and
`MUSAI_CLEARANCE` for the CLI, never by a call; the server refuses to start on a flag it does not
read, or with `MUSAI_CLEARANCE` set and no `--clearance`. A workspace opened under one reads the
**cleared fold**, `cleared/<audience digest>.sqlite` beside the scope's, which folds every commit
and admits a record only where it is not sealed from that clearance, in log order; it is refolded
from nothing when the standing that judges it moves, never back under a judgement made before the
one it holds, and holds no commit that admitted nothing, so a sealed record's restatement moves no
byte a station prints, nor does the landing of a record withheld for what it reads, supersedes or
attests, whose id a corrupt path named before: that refusal stands. A call closes every fold it
opened when it ends, a refused open's included, so a scope's directory can be removed after one.
There a sealed record is absent, `no-such-record`, never named sealed; its evaluations and briefs
are their own, the clearance in their recipe; a verb that reads a file by path (`--input <file>`
too, refused before the file is opened), or works in what the machine keeps for its author (the view
worktrees `open` and `save` use, the trust branch's configuration `config` reads and writes, the
scopes and their tips, the store's layout), is refused, and `doctor` counts none of the store's
records or objects. A clearance bounds what a station's own commands read, as well as what the
kernel shows: there every run goes through the container substrate, its tree mounted with the
workspace's `.musai/` masked by an empty mount and no network, and a recipe declaring no image runs
in the one the trust branch's `config.json` names by digest as `station.image`, which enters the
recipe so its receipt names what ran and never shares an id with the author's run on the host, and a
station reading without performing reads only the receipts in that image; a run standing outside the
project is refused, since its mount would show the host; with no image, or no engine, the run is
refused before anything spawns, and nothing of that run is recorded, a round's runs all judged
before any of its needs starts, the refusal ending the station's own call and answering a
subscription's dispatched run as any refused need does, its write standing. A recipe declaring its
own image keeps its id there, so a station's receipt may answer the author's need: the image and the
tree are the same, the mask withholds only `.musai/`, and a result resting on `.musai/` is the
recipe's own mistake. A recipe refused for its
own words (a working directory leaving its checkout, an engine client name declared) is answered as
the author's is, before the mount is judged; one refused only once the machine resolves it (a
substrate that does not resolve, a working directory reaching out of its checkout through a link) is
judged by its mount first, and a mount's refusal ends the call. A sealed record is not a sealed
value: the `$sealed` form above is ciphertext every reader holds. A seal hides bytes and a salt
hides guesses: a station that holds the text of a sealed, unsalted record, or guesses it, confirms
it by hashing it to an id it saw cited, which a salted record's id resists, since the station salts
under its clearance. A station still learns that something was withheld, never what: two logs that
differ in a sealed record's bytes differ in every later commit a station sees, and a cursor naming
a commit its cleared fold no longer holds is refused `stale`, as a read by id of a record it once
saw answers `no-such-record`.

**Signing** is a slot: `off`, `person` (every attestation by a human is signed and verified against
the allowed-signers file before anything advances), `all`. It defaults to `off`, since a fresh
workspace's allowed-signers file is empty by design and a `person` default could never advance.
An attestation is signed whenever a key can be found, whatever the level: one stored unsigned can
never be signed later, and a workspace that raised its level would find its history unverifiable.
The key is the invocation's, else this machine's configuration under `local/`, else the pair beside
the public key the allowed-signers file registers for the principal: the most deliberate answer
wins. That key is the principal, its fingerprint read from the public half beside it, so a preview
names who performing would without spawning a signer, and a key signs only as itself. A signature is a sidecar in the signer's
own format over the attestation's stored bytes — the ones git holds, never a record
re-canonicalised after it was read, which would differ the moment the kind's version moves:
`<id>.sig` from `ssh-keygen -Y sign` under the `musai`
namespace, `<id>.sigstore.json` for a Sigstore bundle. It survives re-sharing and history rewrites
with its record, `sha256sum` reproduces any id, and `ssh-keygen -Y verify` checks any signature
with no git configuration involved. Which attestations have verified is cached beside the fold,
keyed by attestation id and the digest of the allowed-signers bytes, never inside it, since what a
key file grants is not in the log; only successes are cached, since a failure can be transient.
**The index** is
`node:sqlite` (`bun:sqlite` under Bun), one fold per scope over the records from the last indexed
commit, kept in `local/scopes/<scope>/`, a directory of its own apart from the workspace key and
every other file the workspace keeps in `local/`, so no scope's name can land on one of them, and
never committed; a workspace that arrives without `local/`, as every clone does, opens and folds
from the log, and a module's bundle, held on the store's `blobs` branch, travels with it and is
materialised into `local/` on first use; a directory holding no workspace is refused by name; the index holds every kind
and is what an operation reads. The workspace key is minted only where no enclosing working tree
would stage `local/`, asked of `local/` rather than of the workspace: an enclosing project may
commit a workspace's records on purpose, but an add-everything there must never pick up the key or
the fold. Where two records could answer
one name, slot, id or binary, the fold decides by an explicit, meaningful order — a ref, a pin, or a
declared fact the records themselves carry — never by scan order, hash order or iteration order; a
content hash orders records but means nothing about which one a person should read as current, and
a fold that lets one decide is a coin flip wearing determinism's clothes. Where no such order
exists because two records genuinely disagree, the fold refuses rather than picking one in
silence. **Hand edits**: `musai open <case>` materialises the dossier, drafts and artifacts into
a worktree under the workspace's own local directory, `musai save` turns the edits back into
records naming what each was edited from, and `view/<slug>` holds the same materialisation for
reading on a forge. The view branch is derived, exactly like the index: rebuilt from records, never
signed, never pushed, and safe to discard — a stale one is `musai doctor`'s to remove, never a
fact anything else depends on.

## Federation

A claim that leaves the machine is the record it already is with its attestations: assertion,
provenance and publication as separate content-addressed records. `musai remote add <git-url>
--class peer` names a remote and
its **signer class**: self, peer, known, unknown. A signer class is inbound only: it caps the
evidence kind the remote's assertions may count as, and says nothing of what the remote receives; testimony is a citation until a local re-run mints a receipt, and re-verify-on-pull
is a policy with a budget. A federated slot holds many signed assertions; status is computed
locally and opinions never merge. Retractions travel and stale their dependents; a re-share keeps
the original signature and adds an attestation. A push carries an export branch built from the
records standing released to an audience the remote is a member of. Pulled records are unioned
in and inert until a case cites them or a policy acts. A force-pushed remote drops nothing locally;
the records it lost are flagged. A person keeps their own attestations and the briefs their rulings
read: no policy of a scope or a remote takes them from the store of the person who signed them.

**Trust** is three files on `main`: `allowed-signers` says who is who, `roles` who may decide, and
`audiences` who may receive. A peer's maintainer role over their project is one line the workspace
owner adds, never a heuristic. An **audience** is `public`, one key (`key:SHA256:…`), one Sigstore
identity (`identity:<issuer>#<subject>`), or a name `audiences` defines by its members and by the
names it `includes`. Only `public` and `includes` make one audience cover another, a member key is
covered by the audiences holding it, and a cycle of `includes` is a `declaration-conflict`.
`musai init` writes `peer` and `known`, `known` including `peer`. A release binds its audience by
name, so a member added later receives what was released before; the trust branch's history is
the record of who could. Signer classes and audiences are two relations over the same remotes,
never one list: a feed whose signatures count may be sent nothing, and a receiver may be sent what
its own assertions could never count for. **Identity**: SSH keys locally, offline; a published claim
is additionally signed keyless through Sigstore, a short-lived certificate bound to the forge login
and a transparency log entry by hash, so a stranger gets identity and tamper evidence without key
exchange, and an embargoed claim skips the log. What is published is a **bundle**: one file with a
digest, holding a case's records, the releases they leave under, their signatures and the three
trust files at the pinned commit, beside a manifest naming its root, the audience it was cut for
and when. It is shaped as an in-toto Statement in a DSSE envelope under the predicate type
`https://musai.dev/bundle/v1`, whose predicate carries the root, the audience and the digest of
each trust file. An attestation record projects onto its own Statement without changing shape, its
subject becoming the statement's subject and the rest the predicate; a closure release lists every
record of its closure as a subject, so a generic in-toto verifier checks that a file is released
without knowing what a closure is. The publish sink runs as a forge workflow that attests the bundle, so a receiver
checks it with `gh attestation verify --owner`, which validates certificate extensions only a
workflow-minted certificate carries; `cosign attest-blob` over the same bundle serves a receiver
without the forge. Sigstore proves who signed; what they may decide
comes from the roles file alone.

## Verification

**The floor**, fixed for every pack: the prosecutor never sees the author's reasoning and holds no
write tool; a challenge carries a receipt or a citation or a script that reproduces what it
claims, and an executable one outranks a cited one; a dismissal costs a second reader who sees
the challenge and the evidence and never the answer; a tie goes to a ruler who rules on citations
and says when it is taste; two disagreements on one case send it back to its plan gate; a
challenge to the whole approach needs a second reader to agree before it reopens anything. Clean
reviews are silent. The blindness is held by tooling rather than by the brief: interactively the
plugin's `PreToolUse` hook refuses `Read`, `Grep` and `Bash` under `.musai/` when `agent_type`
names the prosecutor or the second reader, and under the driver `canUseTool` refuses the same.

**The crew** are agent definitions with their own model and tools. Prosecutor and second reader
default to a different model from the author's. Challenges arrive as structured output straight
into the kernel, which computes escalation from the graph; the model cannot miscount.

**Checks versus judgments.** Reproduces, control-clean, test-red-without-the-fix, suite-green,
authorship-clean, numbers-trace: checks, decided by runs. Owed-by-an-oracle, decided-on-purpose,
will-be-taken-as-new, maintainer-will-accept, reads-as-native, approach-is-right: judgments, and
the prosecutor's first move on one is to write a script that would falsify it. The **text check**
runs over findings and again over the draft, and may charge two things only: no recorded run
produced this, or the re-run disagrees. **Lessons** accumulate as rules in the project's scope: what
maintainers demanded with the shape each demand applies to, what a person declined, what a second
reader sustained, where a falsifier found a test that pinned nothing.

## Packs

Three ship as the proof that the core is general.

**Bugs.** A booker reads a directory of reports with a runnable suite beside them, or a tracker.
Setlist: reproduces and control-clean (checks with receipts against pinned substrates);
owed-by-an-oracle, decided-on-purpose, taken-as-new (judgments); a disposition gate with three
exits, file, comment, withdraw; a draft; the text check; a publish gate. Sinks: a new issue, a
comment.

**Tickets.** A booker reads issues by number, label query or board column. Setlist: reproduces;
cause with the commit that introduced it and whether it was deliberate; a failing test named for
the invariant (evidence gate); the fix; test-red-without-the-fix, suite-green, authorship-clean
(checks); merge-ready and reads-as-native (judgments, with harvested demands as lessons); a
changelog entry; a publish gate. Sinks: a pushed branch under the configured prefix with
`--force-with-lease`, a draft pull request from a body file, a self-assignment.

**Long-form fiction.** Facts at story coordinates with what each scene read and wrote; laws with
weight and scope, and a floor; a brief as what holds at a coordinate; critics as the crew that
challenges a scene's claims; an accepted objection as a lesson; curves as derived claims along
the timeline. The generality test: nested coordinates, weighted scoped rules, multi-valued slots,
derived values.

## Delivery

```
npm install --global checkwhy
```

The engine ships as one npm package, `checkwhy`, whose command is `musai`, because npm refuses
`musai` as too near `must`. It needs Node 24 or later and git, and otherwise ships as a compiled
binary for the platform from Releases, checksum verified. The Claude Code plugin is one shell over
it, not the way in: installed from its marketplace, its install prompt asks for the workspace
directory, the forge, the branch prefix and the signing level, and on the first session a
`SessionStart` hook installs the same engine into the plugin's persistent data directory, with a
launcher and a `.cmd` beside it that hooks and the MCP server call. The distribution carries its
core module's built bundle, manifest and build receipt, and `musai init` installs the three into a
workspace holding no core module, through the one install path every module takes, so a fresh
workspace has the declarative rule before its first booking. That build receipt is minted at a
pinned instant: every workspace descends from the commit that installs it and a brief names its
scope head, so a build-time clock would move every brief and ruling on every build. It still
records the build's node, esbuild and clone path, so its ids hold only within one clone. `musai
doctor` checks git, the forge CLI, SSH signing, the runtime and Docker. Windows is supported, not
first-class: hooks stay in exec form and no shell script ships but the two bootstraps, while the
gaps in `WINDOWS.md` close once someone runs it there.

## Acceptance

Three runs, none touching today's skills, state or worktrees.

0. **First use.** The author's own agent sessions mint `check` records daily for a week; one
   upstream bug leaves with a receipt a maintainer re-runs and says so; this repository's own
   `corpus/` is booked through `check`; a stranger reaches `check` from the README in five minutes.
1. **The bug corpus.** `musai book <the author's external corpus root> --kind bugs.claim` opens
   eight cases. The prosecutor receives the claim, the runnable suite, the upstream tree at the
   pinned commit and the tracker; the author's own analyses of each bug are the defence's
   material. Pass: every case reaches its disposition gate with the record complete, every number
   in a body traces to a run, and any disposition that differs from the corpus comes with a
   citation. The corpus has two roots — this repository's own `corpus/` directory, seeded with
   the bugs this project hit while building itself, and the author's external one, named by
   workspace configuration or the `MUSAI_CORPUS_DIR` environment variable — and this eight-case
   acceptance gate runs on the external root or a copy of it.
2. **The four items.** `musai book <repository>#<number>`, naming four issues the author has
   already worked across two client libraries, opens four cases in fresh worktrees under a prefix
   chosen at init, so today's branches and pull requests stay. Pass: each reaches its publish
   gate with a body to compare against today's, and every gate was a menu that could be answered
   differently.

## Build order

| Milestone | Delivers | Verifiable by |
| --- | --- | --- |
| M0 kernel | record store on git, index, evaluator with status and staleness, the module boundary with the in-process host, `init` / `status` / `log` / `why`, attestations with sidecar signatures | a hand-written graph in a fixture repo; status and `why` agree with the theory's worked examples; two writers race on one scope and both land |
| M1 modules | contribution registries, core dimensions, base claim types, base roles, presets, the dev kit, the Bun-compile against Node SEA spike | a data-only module and a TypeScript module load through both hosts, fail closed on collision, pass `musai test` |
| M2 surfaces and bugs | MCP server, CLI, plugin shell, gates by elicitation and by menu, the bugs pack, the directory booker | the eight claims to their disposition gate |
| M3 verification | crew, playbook, challenge ladder in the kernel, text check, executable challenges | the bug run end to end |
| M4 tickets | forge booker, worktrees, the revert-the-fix check, authorship, sinks, publish gate | the four-item redo |
| M5 autonomy | SDK driver, lanes, delegate, budgets, explore, night report, rehearsal | `musai run --preset overnight` from a terminal |
| M6 federation | remotes, signer classes, audiences, export by release attestation, Sigstore | two musais exchange a claim and re-verify it |
| M7 whole | fiction pack, retro, docs, Windows CI, binaries, a release | a stranger installs it and books a case |

## Dials

| Slot | Chosen | Alternatives |
| --- | --- | --- |
| Engine | arguments and computed status | workflow engine with stages; adjudication ledger |
| Sandbox | one boundary, in-process and subprocess hosts, Extism when a module from outside exists | Extism only; Node permission model per process; Hardened JS; isolates |
| Truth | immutable records in git, disposable index | mutable files on a branch per case; SQLite truth; SQLite committed through a render filter |
| Ownership | shared claims, cases cite | one flat graph; case-owned copies |
| Statement | typed records, triple as base | typed only; prose with semantic identity |
| Dimensions | core types, modules instantiate | fixed core dimensions; anything with pack ordering code |
| Scopes | closed algebra plus coded reference | algebra only; references only |
| Identity | declared per claim type | inferred from reads; everything present |
| Sovereignty | set-aside on the record | only a run beats a run; only above an authority level |
| Authority | explicit matrix with shipped roles | owner/maintainer/arbiter fixed; flat latest-wins |
| Stand-in | bounded delegate | explore; park |
| Contributions | declarative only | declarative plus activate; imperative only |
| Side effects | runs at triggers | adapters with their own I/O |
| Run environment | declared, secrets keyed-hashed | inherited from the shell; plain hashes |
| Record form | RFC 8785 JSON, `sha256:<hex>` | dag-cbor with CIDs; git trees |
| Provenance | attestation records | inside every record; split by kind |
| Redaction | whole record | salted field hashes |
| Export | a release attestation per record or per closure, naming an audience | a visibility field inside the record; a fixed ladder of classes |
| Surfaces | dynamic via MCP, generated when declared | dynamic only; generated only |
| Trust | three explicit files | plus the forge; plus vouching |
| Federation | git remotes | topic subscriptions; a hub |
| Identity | SSH plus Sigstore | SSH only; Sigstore only |
| Published envelope | in-toto Statement in DSSE | a home-grown envelope; bare signed records |
| Words | plain concepts, venue verbs | plain only; venue throughout |

## Not chosen

- **A required daemon.** Most capable, and a process to babysit: nothing depends on one, though a
  GUI may keep a local server running while it is open.
- **Channels** for waking a session; a research preview processed on the next turn.
- **A declarative rule language.** Rules are typed records where they are data and pure functions
  where they compute.
- **Model-based weight.** An agent's judgment weighs the same whichever model produced it; the
  retro shows whose get overturned.
- **Counting.** Ten judgments never outweigh one run.
- **The forge as a trust source.** Collaborator lists need push access and maintainers rarely
  publish signing keys, so it would grant roles only where you already hold them; a line in the
  roles file costs less than a heuristic that has to be explained.
- **Mutable files per claim.** Two lanes or two peers editing one file conflict; immutable records
  union.

## Theory, for whoever wants it

Claim = an argument's conclusion; challenge = attack; holds / fails / open = the grounded extension
of Dung's abstract argumentation (1995); check = strict rule and judgment = defeasible rule with
preferences, as in DeLP and ASPIC+; specificity is DeLP's default comparison; stale = the verifying
traces of *Build Systems à la Carte* (Mokhov, Mitchell, Peyton Jones 2018), the design under
rust-analyzer's Salsa; why = the derivation tree; the record set is a grow-only set, the simplest CRDT; a record's bytes are RFC 8785 canonical
JSON; a published claim is nanopublication-shaped;
package URLs identify versions; Sigstore signs keyless with a transparency log; Extism, when it
lands, runs WebAssembly plugins with manifest-declared capabilities.

## Risks

- The Extism JS SDK is pre-1.0 and has shipped nothing in over a year, which is why the Wasm host
  waits for a module from outside; when it lands, QuickJS-in-Wasm is slower than V8, and rules
  that turn out hot move into the kernel as services.
- Grounded semantics is polynomial; preferred and stable are not, and are never needed.
- How Claude Code renders an enum elicitation decides whether the CLI gate path is pleasant;
  checked at M2, with the menu path as the default either way.
- Plugin-shipped agents ignore `hooks`, `mcpServers` and `permissionMode`; read-only roles use
  `tools`, which is honoured.
- Sigstore needs the network; offline, published claims carry SSH signatures only.
