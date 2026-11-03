import { splitByShell } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { commandLine, holdsDollarWord } from "../src/shell.js";

describe("commandLine: a command printed as the line a shell reads back into it", () => {
  test("quotes only what a shell would split, expand or assign, as the verifier's line does", () => {
    expect(commandLine(["musai", "a b", "it's", "$HOME", "plain-arg_1.0", ""])).toBe(
      `musai 'a b' 'it'\\''s' '$HOME' plain-arg_1.0 ''`,
    );
  });

  test("leaves a backtick, a backslash and a double quote inert inside single quotes", () => {
    expect(commandLine(["sh", "-c", 'echo "`id`" \\$x'])).toBe(`sh -c 'echo "\`id\`" \\$x'`);
  });

  test.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
    ["a dollar sign", ["echo", "$HOME", "${PATH}", "$(id)"]],
    ["a backtick", ["sh", "-c", "echo `id`"]],
    ["a backslash", ["printf", "%s\\n", "a\\b", "\\"]],
    ["quotes of both kinds", ["node", "-e", `console.log("it's")`, "'", '"']],
    ["an empty argument and a space", ["printf", "", "a b"]],
    ["an assignment and a leading equals sign", ["A=b", "=cmd", "x"]],
    ["a percent sign", ["%1", "a%b"]],
    ["a line feed, a tab and a return", ["printf", "a\nb", "c\td", "e\rf"]],
    ["a control sequence, a quote and a backslash beside it", ["printf", "\u001b[2K'\\x0a"]],
    ["a bidirectional override and a C1 control", ["echo", "‮abc", "c1\u0085", " "]],
    ["an escaped character before an octal digit", ["printf", "\u00017", "\n0"]],
  ])("an argument holding %s pastes back as itself", async (_, command) => {
    expect(await splitByShell(commandLine(command))).toEqual(command);
  });

  test("leaves bare an argument no shell would split, expand or assign", () => {
    expect(commandLine(["node", "check.js", "--flag", "a,b", "user@host:/p_1.0", "+"])).toBe(
      "node check.js --flag a,b user@host:/p_1.0 +",
    );
  });

  test("quotes an equals sign and a percent sign, so no word reads as an assignment or a job", () => {
    expect(commandLine(["A=b", "x", "--flag=a", "+%"])).toBe("'A=b' x '--flag=a' '+%'");
  });

  test("writes an argument holding what a terminal would act on as one $'…' word, its bytes in octal", () => {
    expect(commandLine(["printf", "a\nb\r\t\u001b[2K", "it's \\ ‮"])).toBe(
      "printf $'a\\nb\\r\\t\\033[2K' $'it\\'s \\\\ \\342\\200\\256'",
    );
  });

  test("prints an argument of controls and formatting characters as printable ASCII alone", () => {
    const line = commandLine(["x", "\u0000\u001f\u007f\u0085؜‏ ⁦"]);
    expect([...line].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) < 0x7f)).toBe(
      true,
    );
  });

  test("says a line holds a $'…' word exactly where an argument holds a character printable escapes", () => {
    expect([holdsDollarWord(["printf", "a\tb"]), holdsDollarWord(["echo", "it's $HOME", "A=b", "\\x0a"])]).toEqual([
      true,
      false,
    ]);
  });
});
