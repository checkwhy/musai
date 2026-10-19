// Bait for the orphan check: the file exports only an interface, which the
// symbol rule passes over, and no other file names it, so no production file
// reaches the file at all.
export interface Unreached {
  readonly label: string;
}
