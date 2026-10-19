export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export { point as at } from "@musai/records";
// Bait for the boundary check: a surface is held to its own names as a
// kernel-side package is, so the re-export of records' point on the second
// line fails under another name as under its own. The re-export of a type a
// third-party package defines on the first line passes.
