import { KernelError } from "../reason/error.js";
import { SchemaCompiler } from "./schema-compiler.js";

/** Layers a declaration may permit; a slot's default is its own field, not a layer's assignment. */
export const ASSIGNABLE_SLOT_LAYERS = ["project", "preset", "booking"] as const;

export type AssignableSlotLayer = (typeof ASSIGNABLE_SLOT_LAYERS)[number];

export function isAssignableSlotLayer(value: unknown): value is AssignableSlotLayer {
  return typeof value === "string" && (ASSIGNABLE_SLOT_LAYERS as readonly string[]).includes(value);
}

/** A slot's contract, read from an installed module's manifest; the kernel declares no slot. */
export interface SlotDeclaration {
  readonly id: string;
  readonly schema: unknown;
  readonly hasDefault: boolean;
  readonly default: unknown;
  readonly documentation: string;
  readonly layers: readonly AssignableSlotLayer[];
}

export type SlotRegistry = ReadonlyMap<string, SlotDeclaration>;

export class SlotRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "SlotRefusedError";
  }
}

/** Project-only: a pack cannot grant itself irreversible effects, and a preset is a pack's data. */
export const PACK_IRREVERSIBLE_SLOT_ID = "musai.core/pack-irreversible";

/** Project-only, gated by `configure-floor` like every other change to the floor. */
export const SIGNING_LEVEL_SLOT_ID = "musai.core/signing-level";

/** Slots a preset or a booking can never lower below what the project set. */
export const PROJECT_ONLY_SLOTS: ReadonlySet<string> = new Set([SIGNING_LEVEL_SLOT_ID, PACK_IRREVERSIBLE_SLOT_ID]);

const schemas = new SchemaCompiler();

export function validateSlotValue(declaration: SlotDeclaration, value: unknown): void {
  const validate = schemas.compile(declaration.schema as Record<string, unknown> | boolean);
  if (!validate(value)) {
    throw new SlotRefusedError(
      `refusing ${declaration.id}: its value disagrees with its own schema: ${schemas.errorsText(validate.errors ?? [])}`,
    );
  }
}

/** Slot assignments by id; data only, so a manifest with no bundle can contribute one. */
export interface PresetDeclaration {
  readonly id: string;
  readonly assignments: Readonly<Record<string, unknown>>;
  readonly documentation: string;
}

export type PresetRegistry = ReadonlyMap<string, PresetDeclaration>;

/** Checks a preset against the slot registry, so one that stopped matching fails when the module
 * set changes rather than at a run. */
export function validatePresetAssignments(preset: PresetDeclaration, slotRegistry: SlotRegistry): void {
  for (const [slotId, value] of Object.entries(preset.assignments)) {
    const declaration = slotRegistry.get(slotId);
    if (declaration === undefined) {
      throw new SlotRefusedError(`refusing ${preset.id}: it assigns ${slotId}, which no installed module declares`);
    }
    if (!declaration.layers.includes("preset")) {
      throw new SlotRefusedError(
        `refusing ${preset.id}: it assigns ${slotId} at the preset layer, which this slot's own declaration does not permit`,
      );
    }
    try {
      validateSlotValue(declaration, value);
    } catch (error) {
      // The inner refusal names which part of the schema the value failed.
      const detail = error instanceof SlotRefusedError ? error.message : String(error);
      throw new SlotRefusedError(
        `refusing ${preset.id}: its value for ${slotId} disagrees with that slot's own schema — ${detail}`,
      );
    }
  }
}
