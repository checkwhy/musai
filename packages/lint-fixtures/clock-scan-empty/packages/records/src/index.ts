// Bait for the clock check: a production file whose one `Date` is built from a
// value, which parses it rather than reading the clock, so the scan matches no
// read anywhere and proves nothing.
export const epoch = new Date(0).getTime();
