// Not bait: the platform's own modules, which no manifest declares — one
// under the node: prefix, one Node lists among its built-in modules under
// its bare name, and one under Bun's prefix. Each passes.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "path";

export const platform = [Database, readFile, join];
