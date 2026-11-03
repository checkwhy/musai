import type { RevokedRelease, StandingRelease, Workspace } from "@musai/api-core";
import type { Audience } from "@musai/records";
import { heldKeyPrincipals } from "@musai/trust";
import { markdownCommand } from "./text.js";

/** The keys this machine signs as; a pseudonym is none, since a revocation is always signed, so
 * one in a pseudonym's name was never minted here. */
export function signingKeyPrincipals(opened: Workspace, named: string | undefined): Promise<ReadonlySet<string>> {
  return heldKeyPrincipals({ named, localDir: opened.localDir, allowedSigners: opened.allowedSigners });
}

/** Whose name withdrew `release`, said without the principal so the text stays safe to paste. */
export function withdrawnIn(
  release: RevokedRelease,
  yours: ReadonlySet<string>,
): "in your name" | "in a name this machine does not sign as" {
  return release.withdrawnBy.some((withdrawal) => yours.has(withdrawal.principal))
    ? "in your name"
    : "in a name this machine does not sign as";
}

/** The verb that signs a revocation over `release` anew, as a code span. */
export function revokeAgain(release: RevokedRelease): string {
  return markdownCommand(["musai", "lab", "revoke", release.record.subject, "--to", release.record.audience]);
}

/** The verb that grants `release`'s terms to `to` anew, as a code span, keeping its window only
 * where `windowed`, since a release lapsed outside its window needs another. */
export function releaseAgain(release: StandingRelease, to: Audience, windowed: boolean): string {
  const { subject, extent, terms } = release.record;
  const window = windowed
    ? [
        ...(terms.from === null ? [] : ["--from", terms.from]),
        ...(terms.until === null ? [] : ["--until", terms.until]),
      ]
    : [];
  return markdownCommand([
    "musai",
    "lab",
    "release",
    subject,
    "--to",
    to,
    ...(extent === "closure" ? ["--closure"] : []),
    "--for",
    terms.uses.join(","),
    ...window,
    ...(terms.marking === null ? [] : ["--marking", terms.marking]),
  ]);
}
