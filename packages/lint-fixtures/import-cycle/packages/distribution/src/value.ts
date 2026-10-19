// Not bait: the cycle check refuses a package whose graph has no edges at all,
// so every package it scans carries one import here that is not a cycle.
export const value = 1;
