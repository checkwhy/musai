import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root above `startUrl`, since a bundler may land this code in any chunk. A miss is an
 * installation defect, so it throws a bare `Error` rather than a refusal. */
export function packageRootFrom(startUrl: string): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find this package's own root walking up from ${startUrl}`);
    }
    dir = parent;
  }
}
