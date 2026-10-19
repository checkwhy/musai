export const bundler = import.meta.resolve("esbuild");
// Bait for the boundary check: resolving a package reaches for it as surely
// as importing it does, and the manifest lists esbuild only in
// devDependencies, which a file under src/ may not use.
