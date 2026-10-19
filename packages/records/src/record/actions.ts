export const ACTIONS = ["rule", "set-aside", "publish", "override-person", "configure-floor"] as const;

export type Action = (typeof ACTIONS)[number];

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}
