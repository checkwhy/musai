export * from "dist-alias";
// Bait for the boundary check: the manifest's key names no package, and its
// spec links the distribution under that key, so the kernel-side package
// declares and imports the distribution under another name.
