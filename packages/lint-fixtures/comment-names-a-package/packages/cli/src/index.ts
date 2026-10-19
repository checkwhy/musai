// import { value } from "@musai/records";
/* export { value } from "@musai/records"; */
export const described = 'import("@musai/records")';
// Bait for the boundary check: the surface's manifest declares records in
// dependencies, and this file names it three times without importing it —
// in a line comment, in a block comment and in a string's text — so nothing
// under the surface's src/ imports it.
