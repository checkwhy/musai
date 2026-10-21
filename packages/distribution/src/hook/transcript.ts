interface Entry {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly isMeta?: unknown;
  readonly isSidechain?: unknown;
  readonly cwd?: unknown;
  readonly message?: { readonly content?: unknown };
}

interface Block {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: { readonly command?: unknown; readonly run_in_background?: unknown };
  readonly tool_use_id?: unknown;
  readonly is_error?: unknown;
}

/** A Bash command the assistant called, and the directory the call was made in. */
export interface TurnCommand {
  readonly command: string;
  /** Whether it ran in the foreground and its result came back as no error, which a refused
   * call's never does. */
  readonly ran: boolean;
  readonly cwd: string | null;
}

/** The person's last message onward, as Claude Code's session transcript records it. */
export interface Turn {
  readonly startedAt: string;
  /** What the assistant said after the turn's last tool call. */
  readonly closingText: string;
  readonly commands: readonly TurnCommand[];
}

function entries(jsonl: string): Entry[] {
  return jsonl.split("\n").flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null ? [parsed as Entry] : [];
    } catch {
      return [];
    }
  });
}

function blocksOf(entry: Entry): Block[] {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content)
    ? content.filter((block): block is Block => typeof block === "object" && block !== null)
    : [];
}

/** A tool's result arrives as a user entry, and an injected one is marked meta. */
function isPersonsMessage(entry: Entry): boolean {
  return (
    entry.type === "user" && entry.isMeta !== true && !blocksOf(entry).some((block) => block.type === "tool_result")
  );
}

/** `null` where the transcript holds no message from the person. */
export function lastTurn(jsonl: string): Turn | null {
  const all = entries(jsonl).filter((entry) => entry.isSidechain !== true);
  const start = all.findLastIndex(isPersonsMessage);
  const opening = all[start];
  if (opening === undefined || typeof opening.timestamp !== "string") {
    return null;
  }
  const turn = all.slice(start + 1);
  const returned = new Set(
    turn
      .filter((entry) => entry.type === "user")
      .flatMap(blocksOf)
      .filter((block) => block.type === "tool_result" && block.is_error !== true)
      .map((block) => block.tool_use_id),
  );
  const commands: TurnCommand[] = [];
  let closing: string[] = [];
  for (const entry of turn.filter((candidate) => candidate.type === "assistant")) {
    for (const block of blocksOf(entry)) {
      if (block.type === "tool_use") {
        if (block.name === "Bash" && typeof block.input?.command === "string") {
          commands.push({
            command: block.input.command,
            ran: block.input.run_in_background !== true && typeof block.id === "string" && returned.has(block.id),
            cwd: typeof entry.cwd === "string" ? entry.cwd : null,
          });
        }
        closing = [];
      } else if (block.type === "text" && typeof block.text === "string") {
        closing.push(block.text);
      }
    }
  }
  return { startedAt: opening.timestamp, closingText: closing.join("\n"), commands };
}
