import { isAbsolute, posix, relative, sep, win32 } from "node:path";

/** The working root's label: a path under it records as `./<relative path>`. */
export const WORKING_ROOT_LABEL = ".";

// A Windows path is absolute on any host, so a receipt minted anywhere never carries one.
export function isAnyAbsolute(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function inside(root: string, value: string): string | null {
  // `relative` resolves a path absolute only under the other platform's rules against the cwd.
  if (!isAbsolute(value)) {
    return null;
  }
  const path = relative(root, value);
  return path === ".." || path.startsWith(`..${sep}`) || isAnyAbsolute(path) ? null : path.split(sep).join("/");
}

/** A binding's value as a receipt records it: under a root, relative to it and named by its label;
 * a value naming no absolute path, as it is; `null` for an absolute path under no root. */
export function portableValue(value: string, roots: ReadonlyMap<string, string>): string | null {
  if (!isAnyAbsolute(value)) {
    return value;
  }
  for (const [label, root] of roots) {
    const path = inside(root, value);
    if (path !== null) {
      return label === WORKING_ROOT_LABEL ? `./${path}` : `${label}:${path}`;
    }
  }
  return null;
}

/** Whether a receipt records `value` with no path of this machine, standing on one of `roots`. */
export function recordsPortably(value: string, roots: readonly string[]): boolean {
  return !isAnyAbsolute(value) || roots.some((root) => inside(root, value) !== null);
}
