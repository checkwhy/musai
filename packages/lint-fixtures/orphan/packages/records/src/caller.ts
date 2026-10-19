// The production caller that keeps `reached.ts` off the orphan check's file
// list. It exports nothing, so it cannot be an orphan file itself.
import { reached } from "./reached.js";

reached("  a claim  ");
