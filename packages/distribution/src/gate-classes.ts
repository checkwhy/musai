export const GATE_CLASSES = ["intent", "judgment", "evidence", "publish"] as const;

export type GateClass = (typeof GATE_CLASSES)[number];

export function isGateClass(value: unknown): value is GateClass {
  return typeof value === "string" && (GATE_CLASSES as readonly string[]).includes(value);
}
