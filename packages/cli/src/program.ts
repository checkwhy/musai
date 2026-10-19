import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import {
  clearanceFromEnvironment,
  clockFromEnvironment,
  type Distribution,
  eventsSince,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  principalNameFromEnvironment,
  refuseInputFileUnderClearance,
  runHandler,
  type SubscriptionTrace,
  type WorkspaceRefusal,
} from "@musai/api-core";
import { exitCodeForClass, isKernelError } from "@musai/records";
import { Command, CommanderError } from "commander";
import { renderEventLine, renderProjection, renderRefusalProjection } from "./render.js";

/** A failure naming no reason is a defect: exit 1, the code the table keeps for the kernel. */
function reportFailureAsBug(error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const debugging = (process.env["MUSAI_DEBUG"] ?? "").length > 0;
  process.stderr.write(`${debugging ? (failure.stack ?? failure.message) : failure.message}\n`);
  process.exitCode = 1;
}

/** `tty` only while standard input is an interactive terminal; a script, a hook or an agent's shell
 * is a `process`, whose answers are an agent's. The machine's user never stands for a principal. */
function terminalChannel(): Pick<OperationContext, "via" | "principalName"> {
  return { via: process.stdin.isTTY === true ? "tty" : "process", ...principalNameFromEnvironment() };
}

/** Never stdout, which carries only the operation's own output. */
function reportRefusalToStderr(refusal: WorkspaceRefusal): void {
  console.error(`refused ${refusal.path} at ${refusal.commit}: ${refusal.reason}`);
}

/** Never stdout, which carries only the operation's output. */
async function reportSubscriptionToStderr(trace: SubscriptionTrace): Promise<void> {
  process.stderr.write(
    `subscription ${JSON.stringify(trace.subscription)} refused ${trace.event.name}: ${JSON.stringify(trace.error.code)}: ${JSON.stringify(trace.error.message)}\n`,
  );
}

interface Globals {
  readonly workspace: string;
  readonly scope: string;
  readonly expectHead?: string;
  readonly events?: boolean;
}

/** Streams from the beginning, since a one-shot process holds no cursor, and on stderr, since
 * stdout carries only the operation's output. */
async function streamEvents(context: OperationContext): Promise<void> {
  const opened = await openWorkspace(context);
  const { events } = await eventsSince(opened);
  for (const event of events) {
    process.stderr.write(`${renderEventLine(event)}\n`);
  }
}

/** The group every operation outside a distribution's public set hangs under. */
const LAB = "lab";

/** Commander parses either spelling back to the same camelCase key. */
function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function flagProperty(
  descriptor: OperationDescriptor,
  flag: string,
): { type?: unknown; description?: unknown } | undefined {
  const input = descriptor.input;
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const properties = (input as { properties?: Record<string, unknown> }).properties;
  const property = properties?.[flag];
  return typeof property === "object" && property !== null
    ? (property as { type?: unknown; description?: unknown })
    : undefined;
}

function isRequired(descriptor: OperationDescriptor, name: string): boolean {
  const input = descriptor.input;
  const required = typeof input === "object" && input !== null ? (input as { required?: unknown }).required : undefined;
  return Array.isArray(required) && required.includes(name);
}

function isBooleanFlag(descriptor: OperationDescriptor, flag: string): boolean {
  return flagProperty(descriptor, flag)?.type === "boolean";
}

/** What a flag means, as its input schema describes it, else its name. */
function flagHelp(descriptor: OperationDescriptor, flag: string): string {
  const description = flagProperty(descriptor, flag)?.description;
  return typeof description === "string" ? description : flag;
}

/** A hook hands its payload on standard input, which no flag can carry. */
async function jsonInput(file: string): Promise<unknown> {
  const source = file === "-" ? "standard input" : file;
  let read: string;
  try {
    read = file === "-" ? await text(process.stdin) : await readFile(file, "utf8");
  } catch (error) {
    throw new OperationError({
      reason: "invalid-input",
      about: [source],
      detail: `refusing --input: ${source} could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    });
  }
  try {
    return JSON.parse(read);
  } catch {
    throw new OperationError({
      reason: "invalid-input",
      about: [source],
      detail: `refusing --input: ${source} is not JSON`,
    });
  }
}

function isObjectFlag(descriptor: OperationDescriptor, flag: string): boolean {
  return flagProperty(descriptor, flag)?.type === "object";
}

function objectFlagValue(flag: string, spelled: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spelled);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OperationError({
      reason: "invalid-input",
      about: [`--${kebabCase(flag)}`],
      detail: `refusing --${kebabCase(flag)}: it takes one JSON object, such as '{"key": "value"}'`,
    });
  }
  return parsed as Record<string, unknown>;
}

function isArrayFlag(descriptor: OperationDescriptor, flag: string): boolean {
  return flagProperty(descriptor, flag)?.type === "array";
}

export function buildProgram(distribution: Distribution): Command {
  const program = new Command();
  program
    .exitOverride()
    .name(distribution.command ?? distribution.name)
    .version(distribution.version)
    .option("--workspace <dir>", "workspace directory", process.cwd())
    .option("--scope <name>", "scope name", "default")
    .option(
      "--expect-head <commit>",
      "the store head this write was decided against; refuses closed if the tip has since moved",
    )
    .option("--events", "stream the scope's own events as JSON lines on stderr while the verb runs");

  const groupCommands = new Map<string, Command>();
  /** One command per path, made on first use, so `lab` and the groups under it are made once. */
  function groupAt(path: readonly string[], describe: (name: string) => string): Command {
    let parent = program;
    for (const [depth, name] of path.entries()) {
      const key = path.slice(0, depth + 1).join(" ");
      let group = groupCommands.get(key);
      if (group === undefined) {
        group = parent.command(name).description(describe(name));
        groupCommands.set(key, group);
      }
      parent = group;
    }
    return parent;
  }
  function commandFor(key: string, descriptor: OperationDescriptor): Command {
    const lab = distribution.publicOperations !== undefined && !distribution.publicOperations.has(key);
    const path = [...(lab ? [LAB] : []), ...(descriptor.cli.group === undefined ? [] : [descriptor.cli.group])];
    const parent = groupAt(path, (name) => (name === LAB ? "every other verb" : `${name}'s own verbs`));
    return parent.command(descriptor.cli.verb);
  }

  if (distribution.startHere !== undefined) {
    program.addHelpText("after", `\n${distribution.startHere}`);
  }

  for (const [key, descriptor] of distribution.registry.entries()) {
    const command = commandFor(key, descriptor).description(descriptor.cli.describe);
    for (const name of descriptor.cli.positional) {
      command.argument(isRequired(descriptor, name) ? `<${name}>` : `[${name}]`);
    }
    if (descriptor.cli.rest !== undefined) {
      const rest = descriptor.cli.rest;
      command.argument(isRequired(descriptor, rest) ? `<${rest}...>` : `[${rest}...]`);
    }
    for (const flag of descriptor.cli.flags) {
      const spelling = kebabCase(flag);
      if (isBooleanFlag(descriptor, flag)) {
        command.option(`--${spelling}`, flagHelp(descriptor, flag));
      } else if (isArrayFlag(descriptor, flag)) {
        command.option(
          `--${spelling} <value>`,
          `${flagHelp(descriptor, flag)} (repeatable)`,
          (value: string, previous: string[]) => [...previous, value],
          [] as string[],
        );
      } else if (isObjectFlag(descriptor, flag)) {
        command.option(`--${spelling} <json>`, `${flagHelp(descriptor, flag)} (a JSON object)`);
      } else {
        command.option(`--${spelling} <value>`, flagHelp(descriptor, flag));
      }
    }
    if (descriptor.cli.input !== undefined) {
      command.option("--input <file>", `the ${descriptor.cli.input} as a JSON file, - reading standard input`);
    }
    command.option("--json", "print the operation's output as canonical JSON");
    if (descriptor.effect === "write") {
      command.option("--plan", "preview what this write would mint, writing nothing");
    } else if (descriptor.effect === "performs" && descriptor.plans) {
      command.option("--plan", "answer from what has already run, running nothing");
    }
    command.action(async (...args: unknown[]) => {
      const invoked = args[args.length - 1] as Command;
      const positionalValues = args.slice(0, descriptor.cli.positional.length) as string[];
      const cmdOptions = invoked.opts<Record<string, unknown>>();
      const globals = invoked.optsWithGlobals<Globals>();

      const input: Record<string, unknown> = {};
      descriptor.cli.positional.forEach((name, index) => {
        if (positionalValues[index] !== undefined) {
          input[name] = positionalValues[index];
        }
      });
      if (descriptor.cli.rest !== undefined) {
        const words = args[descriptor.cli.positional.length] as string[];
        if (words.length > 0) {
          input[descriptor.cli.rest] = words;
        }
      }
      for (const flag of descriptor.cli.flags) {
        if (cmdOptions[flag] !== undefined) {
          input[flag] = cmdOptions[flag];
        }
      }
      const json = cmdOptions["json"] === true;

      // A malformed MUSAI_NOW or MUSAI_CLEARANCE renders like any other refusal.
      let context: OperationContext | undefined;
      let output: unknown;
      try {
        const launched: OperationContext = {
          workspace: globals.workspace,
          scope: globals.scope,
          reportRefusal: reportRefusalToStderr,
          reportSubscription: reportSubscriptionToStderr,
          expectHead: globals.expectHead,
          mode: cmdOptions["plan"] === true ? "plan" : "perform",
          now: clockFromEnvironment(),
          clearance: clearanceFromEnvironment(),
          ...terminalChannel(),
        };
        // Some verbs never open the workspace, and none may act under a clearance it refuses.
        if (launched.clearance !== undefined) {
          (await openWorkspace(launched)).close();
        }
        context = launched;
        for (const flag of descriptor.cli.flags) {
          const spelled = input[flag];
          if (isObjectFlag(descriptor, flag) && typeof spelled === "string") {
            input[flag] = objectFlagValue(flag, spelled);
          }
        }
        if (descriptor.cli.input !== undefined && typeof cmdOptions["input"] === "string") {
          refuseInputFileUnderClearance(descriptor, cmdOptions["input"], launched);
          input[descriptor.cli.input] = await jsonInput(cmdOptions["input"]);
        }
        output = await runHandler(descriptor, input, context);
      } catch (error) {
        if (globals.events === true && context !== undefined) {
          await streamEvents(context);
        }
        if (!isKernelError(error)) {
          reportFailureAsBug(error);
          return;
        }
        const rendered = renderRefusalProjection(error, json);
        // No newline under --json, so a refusal's bytes hash like a success's.
        process.stderr.write(json ? rendered : `${rendered}\n`);
        process.exitCode = exitCodeForClass(error.code);
        return;
      }

      if (globals.events === true) {
        await streamEvents(context);
      }
      const rendered = renderProjection(descriptor, output, json);
      process.stdout.write(json ? rendered : `${rendered}\n`);
      process.exitCode = descriptor.exitCode(output);
    });
  }

  return program;
}

/** A parse failure exits 2, the caller's to fix, where commander's default 1 would report a
 * kernel defect. */
export async function runCli(distribution: Distribution, argv: readonly string[]): Promise<void> {
  try {
    await buildProgram(distribution).parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? 0 : 2;
    } else {
      reportFailureAsBug(error);
    }
  }
}
