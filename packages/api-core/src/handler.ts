import { join } from "node:path";
import type { OperationPlan } from "@musai/modules";
import type { EffectClass } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { refuseUnderClearance } from "./cleared-operations.js";
import type { OperationContext } from "./context.js";
import { OperationError } from "./errors.js";
import { assertHeadUnmoved } from "./expect-head.js";
import { closingWorkspaces, openWorkspace } from "./open-workspace.js";
import { type AppliedPlan, admitPlan, perform, planPrincipal, realisePlan } from "./plan.js";
import { type OperationDescriptor, validateOperationInput, validateOperationOutput } from "./registry.js";
import type { Workspace } from "./workspace.js";

export interface PlannedOperation<TOutput> {
  readonly plan: OperationPlan;
  /** A projection, since a minted record's id is known only once the plan is realised. */
  readonly output: (applied: AppliedPlan) => TOutput;
  /** The signing key the caller named, carried beside the plan because a plan names no key. */
  readonly key?: string;
}

/** The pure half of a handler: it performs no run, calls no signer, and reads time from
 * `view.now()` so a plan and its perform mint the same ids. */
export type PlanFunction<TInput, TOutput> = (
  input: TInput,
  view: Workspace,
  context: OperationContext,
) => Promise<PlannedOperation<TOutput>>;

/** An operation supplies only its plan; `perform` applies every operation's plan alike. */
export interface OperationHandler<TInput, TOutput> {
  readonly plan: PlanFunction<TInput, TOutput>;
}

/** Builds a descriptor whose plan is admitted against the same declaration it is built from. */
export function definedOperation<TInput, TOutput>(
  declaration: Omit<OperationDescriptor<TInput, TOutput>, "handler" | "plans">,
  operationHandler: OperationHandler<TInput, TOutput>,
): OperationDescriptor<TInput, TOutput> {
  return {
    ...declaration,
    plans: true,
    async handler(input, context) {
      const view = await openWorkspace(context);
      const planned = await operationHandler.plan(input, view, context);
      const { id, version, effect, authority } = declaration;
      const principal = await planPrincipal(planned.plan, declaration, view, context, planned.key);
      admitPlan(planned.plan, { id, version, effect, authority, contributed: false }, view, context, principal);
      const realised = await realisePlan(planned.plan, view, context, `${id}@${version}`, principal);
      if (context.mode === "plan") {
        return planned.output(realised);
      }
      return planned.output(await perform(realised, planned.plan.needs, view, planned.key));
    },
  };
}

const WRITING_EFFECTS: ReadonlySet<EffectClass> = new Set(["write", "performs", "irreversible"]);

/** Refuses `head-moved` for a writing operation whose caller's head has moved, as its clearance
 * reads the scope. */
export async function assertHeadUnmovedFor(effect: EffectClass, context: OperationContext): Promise<void> {
  if (context.expectHead === undefined || !WRITING_EFFECTS.has(effect)) {
    return;
  }
  if (context.clearance !== undefined) {
    // A station is shown its cleared fold's head, never a commit only what it cannot read moved.
    const opened = await openWorkspace({ ...context, reportRefusal: undefined });
    try {
      await assertHeadUnmoved({ tip: async () => opened.index.watermark() }, context.expectHead);
    } finally {
      opened.close();
    }
    return;
  }
  const store = new Store({
    ctx: { gitDir: join(context.workspace, MUSAI_DIR) },
    scope: context.scope,
    now: context.now,
  });
  await assertHeadUnmoved(store, context.expectHead);
}

function composed(value: unknown): unknown {
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  return Array.isArray(value) ? value.map(composed) : value;
}

/** The kernel refuses a statement outside NFC, and a person's keyboard or file system may hand one
 * over decomposed. */
function composedStatements(descriptor: OperationDescriptor, input: unknown): unknown {
  if (descriptor.statements === undefined || input === null || typeof input !== "object") {
    return input;
  }
  const fields = { ...(input as Record<string, unknown>) };
  for (const field of descriptor.statements) {
    if (field in fields) {
      fields[field] = composed(fields[field]);
    }
  }
  return fields;
}

/** The one entry point every surface calls an operation through, so none skips the head guard. */
export async function runHandler<TInput, TOutput>(
  descriptor: OperationDescriptor<TInput, TOutput>,
  typed: TInput,
  context: OperationContext,
): Promise<TOutput> {
  const key = `${descriptor.id}@${descriptor.version}`;
  const input = composedStatements(descriptor as OperationDescriptor, typed) as TInput;

  await assertHeadUnmovedFor(descriptor.effect, context);

  const inputValidation = validateOperationInput(descriptor as OperationDescriptor, input);
  if (!inputValidation.ok) {
    throw new OperationError({ reason: "invalid-input", about: [key], detail: inputValidation.errors });
  }

  refuseUnderClearance(descriptor as OperationDescriptor, input, context);

  if (context.mode === "plan" && !descriptor.plans) {
    throw new OperationError({
      reason: "invalid-input",
      about: [key],
      detail: `${key} drives a kernel primitive and has nothing to preview: it cannot run in plan mode, so call it performing or not at all`,
    });
  }

  const output: TOutput = await closingWorkspaces(() => descriptor.handler(input, context));

  const outputValidation = validateOperationOutput(descriptor as OperationDescriptor, output);
  if (!outputValidation.ok) {
    throw new OperationError({ reason: "invalid-output", about: [key], detail: outputValidation.errors });
  }

  return output;
}
