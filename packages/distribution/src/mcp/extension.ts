import type { McpDistribution } from "@musai/mcp";
import { MUSAI } from "../musai.js";
import { answerGateThroughElicitation, GATE_ANSWER_ELICITATION_TOOL } from "./gate-tool.js";
import { RERUN_CONFIRMATION_TOOL, rerunWithConfirmation } from "./rerun-tool.js";
import { MUSAI_RESOURCES } from "./resources.js";

/** The musai distribution for MCP; its elicited `gate_answer` and confirmed `bundle_rerun` replace
 * the projected ones a model could fill. Kept off the barrel, so the CLI loads nothing of MCP. */
export const MUSAI_MCP: McpDistribution = {
  ...MUSAI,
  extensions: {
    mcp: {
      tools: [
        {
          tool: GATE_ANSWER_ELICITATION_TOOL,
          call: (session, args) =>
            answerGateThroughElicitation(session.distribution.registry, session.server, session.context, args),
        },
        {
          tool: RERUN_CONFIRMATION_TOOL,
          call: (session, args) =>
            rerunWithConfirmation(session.distribution.registry, session.server, session.context, args),
        },
      ],
      resources: MUSAI_RESOURCES,
    },
  },
};
