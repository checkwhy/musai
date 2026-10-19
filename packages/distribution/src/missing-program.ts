import type { RunObservation, RunRecipe } from "@musai/records";
import { isContainerImageSubstrate } from "@musai/run";

const EXIT_NOT_FOUND = 127;

/** How a shell, `env`, node, a package manager or a container engine reports a program it could
 * not find. */
const NAMED_MISSING: readonly RegExp[] = [
  /\bspawn (\S+) ENOENT\b/,
  /\benv: ['‘]?([^\s'’:]+)['’]?: No such file or directory/,
  /(?:^|\n)(?:\S+: )*(?:line \d+: )?([^\s:]+): (?:command )?not found/,
  /\bexec: "([^"]+)": executable file not found/,
  /\bexecutable file `([^`]+)` not found/,
];

/** pnpm and npm run a package script through `sh` and report only the lifecycle's failure. */
const SCRIPT_SHELL_FAILED = /\bELIFECYCLE\b/;

/** What holds a failed run's programs: the PATH its recipe declared, or the image it ran in,
 * which keeps its own PATH. */
export type ProgramHolder = { readonly declared: ReadonlySet<string> } | { readonly image: string };

/** Who holds the programs of a run: its image where it was held in a container, else the names
 * its recipe declared; `null` where it declared none, as a rule's run does. */
export function programHolderOf(
  run: { readonly recipe: RunRecipe; readonly observation: Pick<RunObservation, "isolationHeld"> },
  declared: ReadonlySet<string> | null,
): ProgramHolder | null {
  const image = run.recipe.substrates.find(isContainerImageSubstrate)?.uri;
  if (image !== undefined && run.observation.isolationHeld === "container") {
    return { image };
  }
  return declared === null ? null : { declared };
}

/** A hint naming the program a failed run seems to have missed, and who lacks it, or `null`. */
export function missingProgramHint(exitCode: number, output: string, holder: ProgramHolder): string | null {
  const declared = "declared" in holder ? holder.declared : new Set<string>();
  const named = NAMED_MISSING.map((shape) => shape.exec(output)?.[1]).find((name) => name !== undefined);
  // An image holds the sh a package script runs in whenever it holds the package manager.
  const scriptShell = "declared" in holder && SCRIPT_SHELL_FAILED.test(output) && !declared.has("sh");
  const guess = named ?? (scriptShell ? "sh" : undefined);
  if (guess !== undefined && declared.has(guess)) {
    return null;
  }
  if (guess === undefined && exitCode !== EXIT_NOT_FOUND) {
    return null;
  }
  const program = guess === undefined ? "." : `: ${guess}?`;
  if ("image" in holder) {
    return (
      `exit and output suggest a program missing from the image ${holder.image}${program} A run in a container ` +
      "keeps its image's own PATH, which --tool and tools.json do not reach: use an image that holds it."
    );
  }
  return (
    `exit and output suggest a program missing from the declared PATH${program} Add it with --tool or to the ` +
    "workspace toolset, or to .musai/local/tools.json where only this machine needs it."
  );
}
