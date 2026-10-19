export interface PendingRecord {
  readonly asking: string;
  readonly answeredBy: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export function pendingFor(
  asking: string,
  answeredBy: string,
  input: Readonly<Record<string, unknown>>,
): PendingRecord {
  return { asking, answeredBy, input };
}
