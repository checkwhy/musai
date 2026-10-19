import { value } from "@musai/records";
// Bait for the boundary check: this package's manifest declares no
// dependencies at all, so the import above names a workspace package it
// never lists.

export const doubled = value * 2;
