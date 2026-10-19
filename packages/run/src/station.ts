import { dirname } from "node:path";
import type { Audience, ResourceDescriptor, RunRecipe } from "@musai/records";
import { KernelError } from "@musai/records";
import { CONTAINER_IMAGE_MEDIA_TYPE, containerEngineAvailable, isContainerImageSubstrate } from "./container.js";
import { pathWithin } from "./substrate.js";

/** The trust branch's configuration key naming a station's image, `<repository>@sha256:<hex>`. */
export const STATION_IMAGE_CONFIG_KEY = "station.image";

const DIGEST_REFERENCE = /^(?<repository>[^@\s]+)@sha256:(?<digest>[0-9a-f]{64})$/;

/** What a run under a clearance is held to: a container that cannot see `musaiDir`. */
export interface Station {
  readonly clearance: Audience;
  /** The image a recipe declaring none runs in; absent, such a recipe is refused. */
  readonly image: ResourceDescriptor | undefined;
  readonly musaiDir: string;
}

/** A run a clearance forbids, refused before anything spawns and never recorded. */
export class StationRefusedError extends KernelError {
  constructor(clearance: Audience, detail: string) {
    super({ reason: "invalid-input", about: [clearance], detail });
    this.name = "StationRefusedError";
  }
}

/** The configured station image as an image substrate pinned by digest; absent, none. */
export function stationImageFromConfig(config: {
  readonly values: Readonly<Record<string, unknown>>;
}): ResourceDescriptor | undefined {
  const declared = config.values[STATION_IMAGE_CONFIG_KEY];
  if (declared === undefined) {
    return undefined;
  }
  const parsed = typeof declared === "string" ? DIGEST_REFERENCE.exec(declared)?.groups : undefined;
  if (parsed === undefined) {
    throw new KernelError({
      reason: "workspace-incomplete",
      about: [STATION_IMAGE_CONFIG_KEY],
      detail: `refusing to read ${STATION_IMAGE_CONFIG_KEY} from the workspace's configuration: it must name an image by digest, as <repository>@sha256:<64 hex digits>`,
    });
  }
  return {
    uri: parsed["repository"]!,
    digest: { sha256: parsed["digest"]! },
    mediaType: CONTAINER_IMAGE_MEDIA_TYPE,
  };
}

/** The recipe a station runs: its own image where it declares one, else the station's, which
 * enters the recipe so the receipt names what ran and never shares an id with a host run. */
export function stationRecipe(recipe: RunRecipe, station: Station): RunRecipe {
  if (recipe.substrates.some(isContainerImageSubstrate)) {
    return recipe;
  }
  if (station.image === undefined) {
    throw new StationRefusedError(
      station.clearance,
      `refusing to run under the clearance ${station.clearance}: a run there goes through a container, the recipe declares no image, and the trust branch's configuration names no ${STATION_IMAGE_CONFIG_KEY}`,
    );
  }
  return { ...recipe, substrates: [...recipe.substrates, station.image], isolation: "container" };
}

/** `stationRecipe`, once the engine that holds it answers. */
export async function stationRecipeReady(recipe: RunRecipe, station: Station, engine: string): Promise<RunRecipe> {
  const held = stationRecipe(recipe, station);
  if (!(await containerEngineAvailable(engine))) {
    throw new StationRefusedError(
      station.clearance,
      `refusing to run under the clearance ${station.clearance}: a run there goes through a container, and ${engine} is not available on this machine`,
    );
  }
  return held;
}

/** The paths a station's container masks in the directory it mounts: `musaiDir`, if inside. */
export async function stationMasks(mounted: string, station: Station): Promise<readonly string[]> {
  if ((await pathWithin(dirname(station.musaiDir), mounted)) === null) {
    throw new StationRefusedError(
      station.clearance,
      `refusing to run under the clearance ${station.clearance}: the run's working directory is outside the project, and a station's run mounts the project alone`,
    );
  }
  if ((await pathWithin(station.musaiDir, mounted)) !== null) {
    throw new StationRefusedError(
      station.clearance,
      `refusing to run under the clearance ${station.clearance}: the run's working directory is the workspace's own directory or inside it, which a station's run never sees`,
    );
  }
  const inside = await pathWithin(mounted, station.musaiDir);
  return inside === null ? [] : [inside];
}
