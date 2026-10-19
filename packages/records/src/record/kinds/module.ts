import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import { isVersionString, type VersionString } from "../../canonical/numbers.js";
import { isPlainObject } from "../../canonical/plain-object.js";
import { ACTIONS, type Action, isAction } from "../actions.js";
import type { DraftResult, KindContract } from "../contract.js";
import { cloneDescriptor, isResourceDescriptor, type ResourceDescriptor } from "../descriptor.js";
import { invalid, isStringArray, parseRecordIdList } from "../fields.js";

/** The request a bundle answers with its own contribution table; no contribution may name it. */
export const DESCRIBE_CONTRIBUTION = "describe";

/** Point names are matched byte for byte, so a blank or stray space would resolve to nothing. */
const POINT_NAME_PATTERN = /^\S+$/;

export function isPointName(name: string): boolean {
  return POINT_NAME_PATTERN.test(name);
}

/** Marks a `template` contribution as a plugin skill, named as `lab plugin sync` writes it. */
export interface SkillMarker {
  name: string;
}

/** How an operation touches the world; every operation declares exactly one. */
export const EFFECT_CLASSES = ["read", "write", "performs", "irreversible"] as const;

export type EffectClass = (typeof EFFECT_CLASSES)[number];

function isEffectClass(value: unknown): value is EffectClass {
  return typeof value === "string" && (EFFECT_CLASSES as readonly string[]).includes(value);
}

/** One contribution a manifest declares. `kind` is an open point name; only an operation carries
 * `effect` and `authority`, and only a template a `skill`. */
export interface ContributionEntry {
  kind: string;
  id: string;
  version: VersionString;
  input: unknown;
  output: unknown;
  documentation: string;
  skill?: SkillMarker;
  effect?: EffectClass;
  authority?: Action | null;
}

export interface OperationContributionEntry extends ContributionEntry {
  kind: "operation";
  effect: EffectClass;
  authority: Action | null;
}

export function isOperationContribution(entry: ContributionEntry): entry is OperationContributionEntry {
  return entry.kind === "operation" && entry.effect !== undefined && entry.authority !== undefined;
}

/** Inputs only the surface or the invoking person supplies; `plan` and `expectHead` never reach
 * an operation. */
const FORBIDDEN_OPERATION_INPUT_PROPERTIES = ["via", "principal", "key", "plan", "expectHead"] as const;

/** Top-level keywords that let an input schema admit an argument its `properties` does not name. */
const OPENING_KEYWORDS = ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "patternProperties"] as const;

/** Why an operation's input is not a closed object schema naming each argument, else undefined. */
function operationInputShortfall(input: unknown): string | undefined {
  if (!isPlainObject(input)) {
    return 'is not an object schema with type "object"';
  }
  if (input["type"] !== "object") {
    return 'does not declare type "object"';
  }
  const properties = input["properties"];
  if (!isPlainObject(properties)) {
    return "declares no properties object";
  }
  if (input["additionalProperties"] !== false) {
    return "does not declare additionalProperties false";
  }
  const opening = OPENING_KEYWORDS.find((keyword) => Object.hasOwn(input, keyword));
  if (opening !== undefined) {
    return `carries ${opening} at its top`;
  }
  const forbidden = FORBIDDEN_OPERATION_INPUT_PROPERTIES.find((name) => Object.hasOwn(properties, name));
  if (forbidden !== undefined) {
    return `declares an input property named ${forbidden}, which only the surface a call arrives through or the invoking person supplies`;
  }
  return undefined;
}

/** A binary a module needs; a requirement is only read, never invoked, so its output is `true`. */
export interface RequirementContributionInput {
  binary: string;
  versionPredicate: string | null;
  neededBy: string;
  install: string;
}

export interface ToolchainEntry {
  name: string;
  version: VersionString;
}

/** Built deterministically from a module's typed export by `musai lab module build`. */
export interface ModuleManifest {
  protocolVersion: number;
  contributions: ContributionEntry[];
  sourceTree: ResourceDescriptor;
  toolchain: ToolchainEntry[];
  packages: string[];
}

/** An installed module, its manifest inline so a receiver reads it without running anything. A
 * data-only module names neither `bundle` nor `build`. */
export interface ModuleRecord {
  kind: "module";
  schemaVersion: number;
  name: string;
  version: VersionString;
  manifest: ModuleManifest;
  bundle: RecordId | null;
  build: RecordId | null;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export type ModuleDraft = Omit<ModuleRecord, "schemaVersion">;

/** Refuses an unsorted manifest, which a second build would not reproduce, and a bundle named
 * without the build that produced it, whose provenance a receiver could not check. */
function validateModule(fields: Record<string, unknown>): DraftResult<ModuleDraft> {
  const { name, version, manifest } = fields;
  if (typeof name !== "string") {
    return invalid("module.name must be a string");
  }
  if (!isVersionString(version)) {
    return invalid("module.version must be a non-empty string with no whitespace");
  }
  if (!isPlainObject(manifest)) {
    return invalid("module.manifest is required");
  }
  const protocolVersion = manifest["protocolVersion"];
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return invalid("module.manifest.protocolVersion must be an integer");
  }

  const contributionsField = manifest["contributions"];
  if (!Array.isArray(contributionsField)) {
    return invalid("module.manifest.contributions must be an array of contribution entries");
  }
  const contributions: ContributionEntry[] = [];
  const seenContributionIdentities = new Set<string>();
  for (const entry of contributionsField) {
    if (!isPlainObject(entry)) {
      return invalid("module.manifest.contributions entries must be objects");
    }
    const entryId = entry["id"];
    if (typeof entryId !== "string") {
      return invalid("a contribution's id must be a string");
    }
    const entryKind = entry["kind"];
    if (typeof entryKind !== "string") {
      return invalid(`contribution ${entryId} must name the point it answers at as a string`);
    }
    if (!isPointName(entryKind)) {
      return invalid(
        `contribution ${entryId} must name its point as a non-empty string with no whitespace: ${JSON.stringify(entryKind)}`,
      );
    }
    if (entryKind === DESCRIBE_CONTRIBUTION) {
      return invalid(
        `contribution ${entryId} names ${DESCRIBE_CONTRIBUTION}, the request name the envelope reserves for a bundle's own contribution table`,
      );
    }
    const entryVersion = entry["version"];
    if (!isVersionString(entryVersion)) {
      return invalid(`contribution ${entryId} must carry its version as a non-empty string with no whitespace`);
    }
    if (!("input" in entry)) {
      return invalid(`contribution ${entryId} must carry an input schema`);
    }
    if (!("output" in entry)) {
      return invalid(`contribution ${entryId} must carry an output schema`);
    }
    const entryDocumentation = entry["documentation"];
    if (typeof entryDocumentation !== "string") {
      return invalid(`contribution ${entryId} must carry its documentation as a string`);
    }
    if (!entryId.startsWith(`${name}/`)) {
      return invalid(`contribution id ${entryId} is not namespaced by its own module's name ${name}`);
    }
    const entryIdentity = `${entryId} ${entryVersion}`;
    if (seenContributionIdentities.has(entryIdentity)) {
      return invalid(
        `module ${name}@${version} declares two contributions sharing one id and version: ${entryId}@${entryVersion}`,
      );
    }
    seenContributionIdentities.add(entryIdentity);
    let entrySkill: SkillMarker | undefined;
    if ("skill" in entry && entry["skill"] !== undefined) {
      if (entryKind !== "template") {
        return invalid(`contribution ${entryId} carries a skill marker but is not a template contribution`);
      }
      const skillCandidate = entry["skill"];
      if (
        !isPlainObject(skillCandidate) ||
        typeof skillCandidate["name"] !== "string" ||
        skillCandidate["name"] === ""
      ) {
        return invalid(`contribution ${entryId}'s skill marker must carry its own name as a non-empty string`);
      }
      entrySkill = { name: skillCandidate["name"] };
    }
    let entryDeclaration: { effect: EffectClass; authority: Action | null } | undefined;
    if (entryKind === "operation") {
      const effect = entry["effect"];
      if (!isEffectClass(effect)) {
        return invalid(
          `operation contribution ${entryId} must declare its effect as one of ${EFFECT_CLASSES.join(", ")}`,
        );
      }
      const authority = entry["authority"];
      if (!("authority" in entry) || (authority !== null && !isAction(authority))) {
        return invalid(
          `operation contribution ${entryId} must declare its authority as null or one of ${ACTIONS.join(", ")}`,
        );
      }
      const shortfall = operationInputShortfall(entry["input"]);
      if (shortfall !== undefined) {
        return invalid(
          `operation contribution ${entryId}'s input schema ${shortfall}: an operation's input is a plain closed object, type "object" with an explicit properties object, additionalProperties false, none of ${OPENING_KEYWORDS.join(", ")} at its top and none of ${FORBIDDEN_OPERATION_INPUT_PROPERTIES.join(", ")} among its properties`,
        );
      }
      entryDeclaration = { effect, authority };
    } else if (entry["effect"] !== undefined || entry["authority"] !== undefined) {
      return invalid(`contribution ${entryId} declares an effect or an authority but is not an operation contribution`);
    }
    contributions.push({
      kind: entryKind,
      id: entryId,
      version: entryVersion,
      input: entry["input"],
      output: entry["output"],
      documentation: entryDocumentation,
      ...(entrySkill === undefined ? {} : { skill: entrySkill }),
      ...(entryDeclaration === undefined ? {} : entryDeclaration),
    });
  }
  for (let index = 1; index < contributions.length; index++) {
    const previous = contributions[index - 1]!;
    const current = contributions[index]!;
    if (previous.id > current.id || (previous.id === current.id && previous.version > current.version)) {
      return invalid("module.manifest.contributions must be sorted by id then version");
    }
  }

  const sourceTree = manifest["sourceTree"];
  if (!isResourceDescriptor(sourceTree)) {
    return invalid("module.manifest.sourceTree must be a resource descriptor naming a locator or a digest");
  }

  const toolchainField = manifest["toolchain"];
  if (!Array.isArray(toolchainField)) {
    return invalid("module.manifest.toolchain must be an array of { name, version }");
  }
  const toolchain: ToolchainEntry[] = [];
  for (const entry of toolchainField) {
    if (!isPlainObject(entry)) {
      return invalid("module.manifest.toolchain entries must be objects");
    }
    const toolchainName = entry["name"];
    const toolchainVersion = entry["version"];
    if (typeof toolchainName !== "string" || !isVersionString(toolchainVersion)) {
      return invalid("module.manifest.toolchain entries must carry a name and a version string");
    }
    toolchain.push({ name: toolchainName, version: toolchainVersion });
  }

  const packagesField = manifest["packages"];
  if (!isStringArray(packagesField)) {
    return invalid("module.manifest.packages must be an array of package-url strings");
  }
  for (let index = 1; index < packagesField.length; index++) {
    if (packagesField[index - 1]! > packagesField[index]!) {
      return invalid("module.manifest.packages must be sorted");
    }
  }

  if (!("bundle" in fields)) {
    return invalid("module.bundle is required");
  }
  if (!("build" in fields)) {
    return invalid("module.build is required");
  }
  const bundle = fields["bundle"];
  const build = fields["build"];
  const hasBundle = bundle !== null;
  const hasBuild = build !== null;
  if (hasBundle !== hasBuild) {
    return invalid(
      "a module naming a bundle must also name the build that produced it, and a build named with no bundle is refused the same way",
    );
  }
  if (hasBundle && !isRecordId(bundle)) {
    return invalid("module.bundle must be a record id or null");
  }
  if (hasBuild && !isRecordId(build)) {
    return invalid("module.build must be a record id or null");
  }

  const supersedes = parseRecordIdList(fields["supersedes"], "module", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  const record: ModuleDraft = {
    kind: "module",
    name,
    version,
    manifest: {
      protocolVersion,
      contributions,
      sourceTree: cloneDescriptor(sourceTree),
      toolchain,
      packages: [...packagesField],
    },
    bundle: hasBundle ? (bundle as RecordId) : null,
    build: hasBuild ? (build as RecordId) : null,
    supersedes: supersedes.ids,
  };
  return { ok: true, record };
}

export const moduleContract: KindContract<"module", ModuleDraft> = {
  kind: "module",
  version: 2,
  normalizers: { 1: (fields) => ({ ...fields, supersedes: [] }) },
  numberPolicy: { schemaVersion: "measured", manifest: { protocolVersion: "measured" } },
  sealedPaths: new Set(),
  packMayDraft: false,
  saltable: false,
  validate: validateModule,
};
