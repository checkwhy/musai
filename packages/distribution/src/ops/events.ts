import type { OperationDescriptor } from "@musai/api-core";
import { type Event, eventsSince, openWorkspace } from "@musai/api-core";
import { EVENT_KINDS, versionString } from "@musai/records";

export interface EventsSinceInput {
  readonly cursor?: string;
}

export interface EventsSinceOutput {
  readonly events: readonly Event[];
  readonly cursor: string;
}

function renderEventsSinceText(output: EventsSinceOutput): string {
  if (output.events.length === 0) {
    return "no events";
  }
  return output.events.map((event) => `${event.kind} ${event.about} @ ${event.at}`).join("\n");
}

/** `events.since@2`: the events after a cursor and the next cursor. Read forward, never pushed, so
 * one stream serves notifications, the CLI and replay. */
export const eventsSinceOperation: OperationDescriptor<EventsSinceInput, EventsSinceOutput> = {
  id: "events.since",
  version: versionString("2"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["events", "cursor"],
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "at", "about"],
          properties: {
            kind: { enum: [...EVENT_KINDS] },
            at: { type: "string" },
            about: { type: "string" },
          },
        },
      },
      cursor: { type: "string" },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["stale", "invalid-input"],
  documentation: "Lists the events after a cursor, and the cursor to read forward from next.",
  cli: {
    verb: "log",
    positional: [],
    flags: ["cursor"],
    describe: "list the events after a cursor",
  },
  renderText: renderEventsSinceText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    return eventsSince(opened, input.cursor);
  },
};
