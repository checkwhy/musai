declare const exactDecimalBrand: unique symbol;
/** A decimal carried as a string so RFC 8785's number formatting never touches its digits. */
export type ExactDecimal = string & { readonly [exactDecimalBrand]: true };

declare const exactIntegerBrand: unique symbol;
/** An integer beyond the double-safe range, carried as a string so no digit is rounded. */
export type ExactInteger = string & { readonly [exactIntegerBrand]: true };

declare const timestampBrand: unique symbol;
/** An instant, carried as an RFC 3339 string rather than epoch milliseconds. */
export type Timestamp = string & { readonly [timestampBrand]: true };

/** The one source of instants an operation stamps; a pinned clock pins them all. */
export type Clock = () => Timestamp;

declare const versionStringBrand: unique symbol;
/** A version carried as a string, so its ordering is pluggable rather than numeric. */
export type VersionString = string & { readonly [versionStringBrand]: true };

const EXACT_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const EXACT_INTEGER_PATTERN = /^-?\d+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const VERSION_STRING_PATTERN = /^\S+$/;

export function exactDecimal(value: string): ExactDecimal {
  if (!EXACT_DECIMAL_PATTERN.test(value)) {
    throw new RangeError(`not an exact decimal: ${value}`);
  }
  return value as ExactDecimal;
}

export function isExactDecimal(value: unknown): value is ExactDecimal {
  return typeof value === "string" && EXACT_DECIMAL_PATTERN.test(value);
}

export function isExactInteger(value: unknown): value is ExactInteger {
  return typeof value === "string" && EXACT_INTEGER_PATTERN.test(value);
}

function splitExactDecimal(value: ExactDecimal): {
  readonly sign: bigint;
  readonly integerPart: string;
  readonly fractionPart: string;
} {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const separatorIndex = unsigned.indexOf(".");
  const integerPart = separatorIndex === -1 ? unsigned : unsigned.slice(0, separatorIndex);
  const fractionPart = separatorIndex === -1 ? "" : unsigned.slice(separatorIndex + 1);
  return { sign: negative ? -1n : 1n, integerPart, fractionPart };
}

/** Compares as arbitrary-precision values, never as doubles. */
export function compareExactDecimal(a: ExactDecimal, b: ExactDecimal): number {
  const left = splitExactDecimal(a);
  const right = splitExactDecimal(b);
  const fractionLength = Math.max(left.fractionPart.length, right.fractionPart.length);
  const leftDigits = BigInt(left.integerPart + left.fractionPart.padEnd(fractionLength, "0"));
  const rightDigits = BigInt(right.integerPart + right.fractionPart.padEnd(fractionLength, "0"));
  const leftValue = left.sign * leftDigits;
  const rightValue = right.sign * rightDigits;
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

export function timestamp(value: string): Timestamp {
  if (!TIMESTAMP_PATTERN.test(value)) {
    throw new RangeError(`not a timestamp: ${value}`);
  }
  return value as Timestamp;
}

export function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value);
}

/** The instant a timestamp names. Strings with different offsets do not sort in clock order, so
 * every comparison across timestamps compares this. */
export function instantOf(value: Timestamp): number {
  return new Date(value).getTime();
}

export function versionString(value: string): VersionString {
  if (!VERSION_STRING_PATTERN.test(value)) {
    throw new RangeError(`not a version string: ${value}`);
  }
  return value as VersionString;
}

export function isVersionString(value: unknown): value is VersionString {
  return typeof value === "string" && VERSION_STRING_PATTERN.test(value);
}

/** Which paths are exact (a string) and which measured (a number); a path absent is not walked. */
export type NumberPolicyShape =
  | "exact"
  | "measured"
  | { readonly [field: string]: NumberPolicyShape }
  | readonly [NumberPolicyShape];

/** One field whose runtime type disagreed with its declared exactness. */
export interface NumberPolicyViolation {
  readonly path: string;
  readonly expected: "exact" | "measured";
  readonly actualType: string;
}

function walkNumberPolicy(
  value: unknown,
  shape: NumberPolicyShape,
  path: string,
  violations: NumberPolicyViolation[],
): void {
  if (shape === "exact") {
    if (typeof value !== "string") {
      violations.push({ path, expected: "exact", actualType: typeof value });
    }
    return;
  }
  if (shape === "measured") {
    if (typeof value !== "number") {
      violations.push({ path, expected: "measured", actualType: typeof value });
    }
    return;
  }
  if (Array.isArray(shape)) {
    const itemShape = shape[0];
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((item, index) => {
      walkNumberPolicy(item, itemShape, `${path}[${index}]`, violations);
    });
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [field, fieldShape] of Object.entries(shape)) {
    if (!(field in record)) {
      continue;
    }
    walkNumberPolicy(record[field], fieldShape, `${path}.${field}`, violations);
  }
}

/** The runtime half of the branded number types, for values that arrive as parsed JSON. */
export function assertNumberPolicy(value: unknown, shape: NumberPolicyShape): NumberPolicyViolation[] {
  const violations: NumberPolicyViolation[] = [];
  walkNumberPolicy(value, shape, "$", violations);
  return violations;
}
