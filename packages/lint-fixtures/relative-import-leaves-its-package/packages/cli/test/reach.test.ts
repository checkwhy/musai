import { value } from "../../distribution/src/index.js";
import { own } from "../src/index.js";
import { next } from "../../cli-next/src/index.js";
// Bait for the boundary check: the first import climbs out of the surface's
// directory into the distribution's source, an edge no manifest declares;
// the second stays inside the surface and passes; the third climbs into a
// sibling whose name begins with the surface's own, which is outside it all
// the same. The rule resolves a path without reading the disk, so no
// directory by that name has to exist.

export const all = value + own + next;
