import type { IndexDb, IndexedContribution } from "@musai/fold";
import type { ContributionEntry } from "@musai/records";
import {
  ASSIGNABLE_SLOT_LAYERS,
  type AssignableSlotLayer,
  isAssignableSlotLayer,
  isPlainObject,
  PROJECT_ONLY_SLOTS,
  type PresetDeclaration,
  type PresetRegistry,
  type SlotDeclaration,
  SlotRefusedError,
  type SlotRegistry,
  validatePresetAssignments,
} from "@musai/records";

/** A slot carries its value's schema in `output` and `{ layers, hasDefault, default }` in
 * `input`; a project-only slot declares the `project` layer alone. */
function slotDeclarationFromEntry(entry: ContributionEntry): SlotDeclaration {
  if (!isPlainObject(entry.input)) {
    throw new SlotRefusedError(`refusing to register ${entry.id}: a slot's input must declare its layers and default`);
  }
  const layersField = entry.input["layers"];
  if (!Array.isArray(layersField) || !layersField.every(isAssignableSlotLayer)) {
    throw new SlotRefusedError(
      `refusing to register ${entry.id}: its declared layers must be an array drawn from ${ASSIGNABLE_SLOT_LAYERS.join(", ")}`,
    );
  }
  const hasDefault = entry.input["hasDefault"];
  if (typeof hasDefault !== "boolean") {
    throw new SlotRefusedError(`refusing to register ${entry.id}: hasDefault must be a boolean`);
  }
  if (entry.output === undefined) {
    throw new SlotRefusedError(
      `refusing to register ${entry.id}: a slot must declare the schema its value satisfies as its output`,
    );
  }

  const layers = layersField as AssignableSlotLayer[];
  if (PROJECT_ONLY_SLOTS.has(entry.id) && (layers.length !== 1 || layers[0] !== "project")) {
    throw new SlotRefusedError(
      `refusing to register ${entry.id}: it is a project-only slot, so its declared layers must be exactly ["project"], got ${JSON.stringify(layers)}`,
    );
  }

  return {
    id: entry.id,
    schema: entry.output,
    hasDefault,
    default: entry.input["default"],
    documentation: entry.documentation,
    layers,
  };
}

function declaredMoreThanOnce(
  id: string,
  declarations: readonly Pick<IndexedContribution, "entry" | "moduleName">[],
): SlotRefusedError {
  const declarers = [
    ...new Set(declarations.filter((each) => each.entry.id === id).map((each) => each.moduleName)),
  ].sort();
  return new SlotRefusedError(`refusing to register ${id}: it is declared more than once, by ${declarers.join(", ")}`);
}

/** Every declared slot, read from manifests in the fold, so no module code runs. */
export function readSlotDeclarations(index: IndexDb): SlotRegistry {
  const declarations = index.contributionsOf("slot");
  const registry = new Map<string, SlotDeclaration>();
  for (const { entry } of declarations) {
    const declaration = slotDeclarationFromEntry(entry);
    if (registry.has(declaration.id)) {
      throw declaredMoreThanOnce(declaration.id, declarations);
    }
    registry.set(declaration.id, declaration);
  }
  return registry;
}

/** Refuses the slots in `name`'s manifest the registry would refuse on its next read. Installed
 * slots are read for their ids only, so one standing refused costs only its own pack. */
export function refuseUnregistrableSlots(
  name: string,
  manifestEntries: readonly ContributionEntry[],
  installed: readonly IndexedContribution[],
): void {
  const heldElsewhere = installed.filter((row) => row.moduleName !== name);
  const declarations = [...heldElsewhere, ...manifestEntries.map((entry) => ({ entry, moduleName: name }))];
  const ids = new Set(heldElsewhere.map((row) => row.entry.id));
  for (const entry of manifestEntries) {
    const declaration = slotDeclarationFromEntry(entry);
    if (ids.has(declaration.id)) {
      throw declaredMoreThanOnce(declaration.id, declarations);
    }
    ids.add(declaration.id);
  }
}

function presetDeclarationFromEntry(entry: ContributionEntry): PresetDeclaration {
  if (!isPlainObject(entry.output)) {
    throw new SlotRefusedError(
      `refusing to register ${entry.id}: a preset's own assignments must be an object mapping slot id to value`,
    );
  }
  return { id: entry.id, assignments: { ...entry.output }, documentation: entry.documentation };
}

/** Every declared preset, revalidated against `slotRegistry` on every read. */
export function readPresetDeclarations(index: IndexDb, slotRegistry: SlotRegistry): PresetRegistry {
  const declarations = index.contributionsOf("preset");
  const registry = new Map<string, PresetDeclaration>();
  for (const { entry } of declarations) {
    const declaration = presetDeclarationFromEntry(entry);
    if (registry.has(declaration.id)) {
      throw declaredMoreThanOnce(declaration.id, declarations);
    }
    validatePresetAssignments(declaration, slotRegistry);
    registry.set(declaration.id, declaration);
  }
  return registry;
}
