const cli = await import(`@musai/cli`);
// Bait for the boundary check: a kernel-side package reaching for a surface
// through a template literal that holds no substitution, which names the
// package as plainly as a quoted string does.

export const doubled = cli.value * 2;
