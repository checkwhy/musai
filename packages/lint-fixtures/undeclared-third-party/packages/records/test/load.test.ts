const ajv = require("ajv");
// Bait for the boundary check: a test may also import what devDependencies
// holds, and the manifest lists ajv in none of its fields.

export const validator = ajv;
