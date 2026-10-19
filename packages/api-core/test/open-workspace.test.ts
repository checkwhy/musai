import { afterEach, describe, expect, test, vi } from "vitest";
import { openWorkspace } from "../src/open-workspace.js";
import { Workspace } from "../src/workspace.js";
import { FIXTURE_CLOCK } from "./fixture-distribution.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the workspace an operation's context opens", () => {
  test("is handed the context's own sink for a subscription's refused answer", async () => {
    const open = vi.spyOn(Workspace, "open").mockRejectedValue(new Error("not opened"));
    const reportSubscription = async (): Promise<void> => {};

    await openWorkspace({ workspace: "/nowhere", scope: "default", now: FIXTURE_CLOCK, reportSubscription }).catch(
      () => undefined,
    );

    expect(open.mock.calls[0]![0].onSubscriptionTrace).toBe(reportSubscription);
  });
});
