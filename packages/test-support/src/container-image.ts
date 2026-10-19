import { execa } from "execa";

/** An image the engine holds locally, named by the digest its registry gave it. */
export interface LocalImage {
  readonly repository: string;
  readonly digest: string;
}

/** The first image held locally by digest in which `command` exits 0 with networking off, as a
 * run's container starts it; never a pull, so a machine holding none answers undefined. */
export async function localImageRunning(command: readonly string[]): Promise<LocalImage | undefined> {
  const listed = await execa("docker", ["images", "--digests", "--format", "{{.Repository}}@{{.Digest}}"], {
    reject: false,
  });
  const references = (listed.stdout ?? "").split("\n").filter((line) => /@sha256:[0-9a-f]{64}$/.test(line));
  const [program, ...args] = command;
  for (const reference of references) {
    const probe = await execa(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", program!, reference, ...args],
      { reject: false, stdout: "ignore", stderr: "ignore" },
    );
    if (probe.exitCode === 0) {
      const at = reference.lastIndexOf("@sha256:");
      return { repository: reference.slice(0, at), digest: reference.slice(at + "@sha256:".length) };
    }
  }
  return undefined;
}
