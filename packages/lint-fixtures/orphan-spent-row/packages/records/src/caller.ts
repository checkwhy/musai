// The production caller that keeps `reached.ts` off the orphan check's lists.
// It exports nothing, so it is neither an orphan symbol nor an unreached file.
import { reached } from "./reached.js";

reached("  a claim  ");
