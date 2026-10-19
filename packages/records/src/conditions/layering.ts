import { recordId } from "../canonical/canonicalize.js";
import { KernelError } from "../reason/error.js";
import {
  type AssignableSlotLayer,
  type SlotDeclaration,
  type SlotRegistry,
  validateSlotValue,
} from "./slot-contribution.js";

/** The layers a slot resolves through, in order; a later layer's assignment wins. */
export const LAYER_ORDER = ["pack-defaults", "project", "preset", "booking"] as const;

export type Layer = (typeof LAYER_ORDER)[number];

/** Each assignable layer's slot values; pack defaults come from the slot's own declaration. */
export interface SlotLayers {
  readonly project?: Readonly<Record<string, unknown>>;
  readonly preset?: Readonly<Record<string, unknown>>;
  readonly booking?: Readonly<Record<string, unknown>>;
}

export interface SlotResolution {
  readonly id: string;
  readonly value: unknown;
  readonly layer: Layer;
  readonly readId: string;
}

export class LayerRefusedError extends KernelError {
  constructor(message: string, slotId: string) {
    super({ reason: "workspace-incomplete", detail: message, about: [slotId] });
    this.name = "LayerRefusedError";
  }
}

/** The read id a slot resolution contributes, so a changed preset stales exactly the claims that
 * read the slot. */
export function slotReadId(id: string, valueContentId: string): string {
  return `slot:${id}=${valueContentId}`;
}

const ASSIGNABLE_LAYER_ORDER: readonly AssignableSlotLayer[] = ["project", "preset", "booking"];

function layerAssignment(
  layers: SlotLayers,
  layer: AssignableSlotLayer,
  id: string,
): { readonly present: boolean; readonly value: unknown } {
  const map = layers[layer];
  if (map === undefined || !(id in map)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: map[id] };
}

/** The last permitted layer to assign the slot wins, else its default. The read id digests the
 * winning value, so it changes only when the value does. */
export function resolveSlot(id: string, registry: SlotRegistry, layers: SlotLayers): SlotResolution {
  const declaration: SlotDeclaration | undefined = registry.get(id);
  if (declaration === undefined) {
    throw new LayerRefusedError(`refusing to resolve ${id}: no installed module declares this slot`, id);
  }

  let winner: { readonly value: unknown; readonly layer: Layer } | undefined;
  if (declaration.hasDefault) {
    winner = { value: declaration.default, layer: "pack-defaults" };
  }

  for (const layer of ASSIGNABLE_LAYER_ORDER) {
    const assignment = layerAssignment(layers, layer, id);
    if (!assignment.present) {
      continue;
    }
    if (!declaration.layers.includes(layer)) {
      throw new LayerRefusedError(
        `refusing to assign ${id} at the ${layer} layer: this slot may only be assigned by ${declaration.layers.length > 0 ? declaration.layers.join(", ") : "no layer"}`,
        id,
      );
    }
    winner = { value: assignment.value, layer };
  }

  if (winner === undefined) {
    throw new LayerRefusedError(`refusing to resolve ${id}: it has no default and nothing assigned it`, id);
  }

  try {
    validateSlotValue(declaration, winner.value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LayerRefusedError(`refusing ${id} at the ${winner.layer} layer: ${reason}`, id);
  }

  const readId = slotReadId(id, recordId(winner.value));
  return { id, value: winner.value, layer: winner.layer, readId };
}
