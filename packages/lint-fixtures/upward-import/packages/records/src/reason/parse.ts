// Bait for the boundary check: `reason` is the bottom of the records
// package's directory order and `record` sits at its top, so a file here may
// not import from there. Nothing else in this root violates anything.
import { render } from "../record/render.js";

export function parse(text: string): string {
  return render(text);
}
