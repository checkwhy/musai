import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_SCHEMA_VERSIONS,
  type IsolationLevel,
  type PerformedRunRecord,
  type ResourceDescriptor,
  type RunRecipe,
  timestamp,
} from "@musai/records";
import {
  CONTAINER_IMAGE_MEDIA_TYPE,
  engineLineOfRun,
  isContainerImageSubstrate,
  RECIPE_CHECKOUT_PLACEHOLDER,
} from "../src/container.js";
import { RUNNER_PERFORMER } from "../src/performer.js";
import { printable } from "../src/printable.js";
import { commandLine } from "../src/shell.js";
import { TREE_SUBSTRATE_URI } from "../src/substrate.js";

export const CONFORMANCE_DIR = fileURLToPath(new URL("../../../conformance", import.meta.url));

const IMAGE_DIGEST = "3f".repeat(32);
const TREE_DIGEST = "9c".repeat(20);
const AT = timestamp("2026-01-01T00:00:00.000Z");

const TREE: ResourceDescriptor = { name: "tree", uri: TREE_SUBSTRATE_URI };

function image(uri: string): ResourceDescriptor {
  return { uri, digest: {}, mediaType: CONTAINER_IMAGE_MEDIA_TYPE };
}

/** A receipt of `recipe` as the runner writes one, each substrate resolved as a run resolves it. */
export function receiptOf(recipe: RunRecipe, held?: IsolationLevel): PerformedRunRecord {
  const declaresImage = recipe.substrates.some(isContainerImageSubstrate);
  return {
    kind: "run",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    recipe,
    observation: {
      resolved: recipe.substrates.map((descriptor) =>
        isContainerImageSubstrate(descriptor)
          ? { ...descriptor, digest: { sha256: IMAGE_DIGEST } }
          : { ...descriptor, digest: { gitTree: TREE_DIGEST } },
      ),
      isolationHeld: held ?? (declaresImage ? "container" : "hygiene"),
      binaries: [],
      bindings: recipe.declared.map(({ name, secret }) =>
        secret
          ? { name, secret, layer: "bindings", value: null, keyedHash: `sha256:${"0".repeat(64)}`, keyId: "k1" }
          : { name, secret, layer: "bindings", value: "eu-west-1", keyedHash: null, keyId: null },
      ),
      output: "",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: AT,
      finishedAt: AT,
      reads: [],
      cost: {},
    },
    supersedes: [],
  };
}

function recipe(overrides: Partial<RunRecipe>): RunRecipe {
  return {
    command: ["go", "test", "./..."],
    workingDirectory: ".",
    environment: {},
    declared: [],
    substrates: [TREE, image("golang:1.25")],
    isolation: "container",
    ...overrides,
  };
}

/** Recipes a verifier prints the engine line of, beside the line the kernel's runner builds. */
export const RECIPE_CASES: readonly {
  readonly name: string;
  readonly recipe: RunRecipe;
  readonly held?: IsolationLevel;
}[] = [
  { name: "a container run at the root of its checkout", recipe: recipe({}) },
  {
    name: "a nested working directory, literals out of order and declared names, one secret",
    recipe: recipe({
      workingDirectory: "pkg/sub/",
      environment: { ZED: "last", ALPHA: "a value", "A+B": "plus" },
      declared: [
        { name: "TOKEN", secret: true },
        { name: "REGION", secret: false },
      ],
    }),
  },
  {
    name: "a tagged image on a registry with a port, and a command a shell would split",
    recipe: recipe({
      command: ["sh", "-c", `echo "$HOME" && ls 'a b'`],
      substrates: [TREE, image("registry.example:5000/team/image:v2")],
    }),
  },
  {
    name: "a command holding a backtick, a backslash, a quote and an empty argument",
    recipe: recipe({ command: ["printf", "%s\\n", "`id`", "a\\b", "it's", ""] }),
  },
  {
    name: "an absolute working directory and no checkout",
    recipe: recipe({ workingDirectory: "/srv/app", substrates: [image("example/image")] }),
  },
  {
    name: "a command whose own arguments follow -v and spell both placeholders",
    recipe: recipe({ command: ["grep", "-v", "$(mktemp -d)x", "-v", `${RECIPE_CHECKOUT_PLACEHOLDER}y`, "."] }),
  },
  {
    name: "literal names integer-like and beyond the BMP, in UTF-16 order",
    recipe: recipe({ environment: { "9": "nine", "10": "ten", "\uFF5E": "tilde", "\u{1F600}": "grin" } }),
  },
  {
    name: "a name declared twice, and a declared name that is also a literal",
    recipe: recipe({
      environment: { SHARED: "literal" },
      declared: [
        { name: "TOKEN", secret: true },
        { name: "SHARED", secret: false },
        { name: "TOKEN", secret: false },
      ],
    }),
  },
  {
    name: "a working directory above the working root, with no checkout",
    recipe: recipe({ workingDirectory: "../sibling", substrates: [image("example/image")] }),
  },
  {
    name: "an image declared, its run held under hygiene by a degrading policy",
    recipe: recipe({}),
    held: "hygiene",
  },
  { name: "a run declaring no image", recipe: recipe({ substrates: [TREE], isolation: "hygiene" }) },
  {
    name: "a command and a literal holding a line feed, a tab, a bidirectional override, = and %",
    recipe: recipe({
      command: ["printf", "a\nb\tc", "\u202eexe.txt", "A=b", "%d", "it's \\"],
      environment: { NOTE: "line\nnext" },
    }),
  },
];

/** Each receipt with its command as a POSIX shell line, and the engine line its run took as
 * arguments and as a shell line, or `null` where it ran outside a container. */
export function recipesTable(): string {
  const cases = RECIPE_CASES.map(({ name, recipe, held }) => {
    const record = receiptOf(recipe, held);
    const engine = engineLineOfRun(record);
    return {
      name,
      record,
      shell: commandLine(recipe.command),
      engine: engine?.argv ?? null,
      engineShell: engine?.shell ?? null,
    };
  });
  return `${asciiJson({ cases })}\n`;
}

/** Texts a verifier prints as the kernel does: controls, separators and bidirectional formatting
 * characters escaped, and their neighbours, a backslash and the rest kept. */
export const PRINTABLE_CASES: readonly { readonly name: string; readonly text: string }[] = [
  { name: "plain text and letters beyond ASCII", text: "plain text \u00b7 with \u00e9 and \u4e2d" },
  { name: "an escape sequence", text: "a\u001b[2Kb" },
  { name: "a return, a line feed and a tab", text: "line\rover\nnext\ttab" },
  { name: "delete and a C1 control", text: "del\u007f and c1\u0085 csi\u009b" },
  { name: "the line and paragraph separators", text: "ls\u2028 ps\u2029" },
  {
    name: "every bidirectional formatting character",
    text: "alm\u061c lrm\u200e rlm\u200f lre\u202a rle\u202b pdf\u202c lro\u202d rlo\u202e lri\u2066 rli\u2067 fsi\u2068 pdi\u2069",
  },
  {
    name: "the characters beside those escaped, and a backslash",
    text: "zwj\u200d nnbsp\u202f \u2065 \u206a nbsp\u00a0 space\u0020 \\u0041",
  },
  { name: "a character beyond the BMP", text: "grin \u{1F600}" },
];

/** Escapes every UTF-16 unit past `~`, so the file holds no character a terminal would act on. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("")
    .map((unit) => {
      const code = unit.charCodeAt(0);
      return code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : unit;
    })
    .join("");
}

/** Each text with what the kernel prints for it. */
export function printableTable(): string {
  return `${asciiJson({ cases: PRINTABLE_CASES.map(({ name, text }) => ({ name, text, printed: printable(text) })) })}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(CONFORMANCE_DIR, "recipes.json"), recipesTable());
  writeFileSync(join(CONFORMANCE_DIR, "printable.json"), printableTable());
  process.stdout.write(`wrote the recipe and printable cases to ${CONFORMANCE_DIR}\n`);
}
