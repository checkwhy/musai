import type { StandingRelease } from "@musai/api-core";
import { type Audience, type RecordId, type ReleaseAttestationRecord, timestamp } from "@musai/records";
import { splitByShell } from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { describe, expect, test } from "vitest";
import { releaseAgain, revokeAgain } from "../src/withdrawn-in.js";

const SUBJECT = `sha256:${"a".repeat(64)}` as RecordId;
const AUDIENCE = "identity:https://issuer.example/?a=1&b=$HOME#ci;run" as Audience;

/** A closure release of `SUBJECT` to `AUDIENCE` that republishes under a licence, in a window. */
function republishing(): StandingRelease {
  const { id, record } = mintAttestation({
    subject: SUBJECT,
    principal: `key:SHA256:${"A".repeat(43)}`,
    principalClass: "person",
    via: "tty",
    purpose: "released",
    at: timestamp("2026-10-11T00:00:00.000Z"),
    release: {
      audience: AUDIENCE,
      extent: "closure",
      terms: {
        form: "bytes",
        uses: ["review", "cite", "republish"],
        from: timestamp("2026-10-01T00:00:00.000Z"),
        until: timestamp("2026-12-01T00:00:00.000Z"),
        marking: "spdx:CC-BY-4.0",
      },
    },
  });
  return { id, record: record as ReleaseAttestationRecord };
}

/** The command inside a one-backtick code span, as a reader pastes it. */
function pasted(span: string): Promise<string[]> {
  return splitByShell(span.slice(1, -1));
}

describe("the commands a withheld release names", () => {
  test("a revocation pastes back as one command for an audience holding shell metacharacters", async () => {
    const span = revokeAgain({ ...republishing(), withdrawnBy: [] });

    expect(await pasted(span)).toEqual(["musai", "lab", "revoke", SUBJECT, "--to", AUDIENCE]);
  });

  test("a release again pastes back as one command granting every term the release granted", async () => {
    const span = releaseAgain(republishing(), AUDIENCE, true);

    expect(await pasted(span)).toEqual([
      ...["musai", "lab", "release", SUBJECT, "--to", AUDIENCE, "--closure", "--for", "review,cite,republish"],
      ...["--from", "2026-10-01T00:00:00.000Z", "--until", "2026-12-01T00:00:00.000Z"],
      ...["--marking", "spdx:CC-BY-4.0"],
    ]);
  });

  test("a release again for one lapsed outside its window names no window", async () => {
    const span = releaseAgain(republishing(), AUDIENCE, false);

    expect(await pasted(span)).toEqual([
      ...["musai", "lab", "release", SUBJECT, "--to", AUDIENCE, "--closure", "--for", "review,cite,republish"],
      ...["--marking", "spdx:CC-BY-4.0"],
    ]);
  });
});
