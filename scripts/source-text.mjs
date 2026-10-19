const REGEX_MAY_FOLLOW_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "typeof",
  "void",
  "yield",
]);

/** A slash divides only after a value; anywhere else it opens a pattern. */
function opensPattern(chars, index) {
  let back = index - 1;
  while (back >= 0 && /\s/.test(chars[back])) {
    back -= 1;
  }
  if (back < 0) {
    return true;
  }
  if (/[)\]"'`]/.test(chars[back])) {
    return false;
  }
  if (!/[\w$]/.test(chars[back])) {
    return true;
  }
  let start = back;
  while (start >= 0 && /[\w$]/.test(chars[start])) {
    start -= 1;
  }
  return REGEX_MAY_FOLLOW_KEYWORDS.has(chars.slice(start + 1, back + 1).join(""));
}

/** Comments and string text blanked character for character, so an index still points into the
 * source. A pattern is stepped over whole: a quote inside it would open a string. */
export function codeOnly(text) {
  return scanText(text).code;
}

/** Every comment in the text, as `{ start, end, kind }` with `kind` "line" or "block". */
export function commentsIn(text) {
  return scanText(text).comments;
}

function scanText(text) {
  const comments = [];
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") {
        out[i] = " ";
      }
    }
  };
  // A template and each `${` in it are frames: template text is blanked, a substitution is code.
  const frames = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (frames.at(-1) === "template") {
      if (char === "\\") {
        blank(index, index + 2);
        index += 2;
      } else if (char === "`") {
        frames.pop();
        index += 1;
      } else if (char === "$" && text[index + 1] === "{") {
        frames.push({ braces: 0 });
        index += 2;
      } else {
        blank(index, index + 1);
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      comments.push({ start: index, end: stop, kind: "line" });
      blank(index, stop);
      index = stop;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      comments.push({ start: index, end: stop, kind: "block" });
      blank(index, stop);
      index = stop;
    } else if (char === "/" && opensPattern(out, index)) {
      index += 1;
      let inClass = false;
      while (index < text.length && text[index] !== "\n") {
        const inside = text[index];
        if (inside === "\\") {
          index += 2;
          continue;
        }
        if (inside === "[") {
          inClass = true;
        } else if (inside === "]") {
          inClass = false;
        } else if (inside === "/" && !inClass) {
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (char === '"' || char === "'") {
      index += 1;
      const start = index;
      while (index < text.length && text[index] !== char) {
        index += text[index] === "\\" ? 2 : 1;
      }
      blank(start, index);
      index += 1;
    } else if (char === "`") {
      frames.push("template");
      index += 1;
    } else if (char === "{" && typeof frames.at(-1) === "object") {
      frames.at(-1).braces += 1;
      index += 1;
    } else if (char === "}" && typeof frames.at(-1) === "object") {
      if (frames.at(-1).braces === 0) {
        frames.pop();
      } else {
        frames.at(-1).braces -= 1;
      }
      index += 1;
    } else {
      index += 1;
    }
  }
  return { code: out.join(""), comments };
}

// A template specifier holding `${` is not read: its substitution survives the blanking.
const QUOTED = String.raw`(["'])[^"'\n]*\1`;
const CALL_ARGUMENT = String.raw`\(\s*(?:(["'])[^"'\n]*\1|(\x60)[^\x60$]*\2)(?=\s*[,)])`;
const FORMS = [
  { kind: "static", pattern: new RegExp(String.raw`(?<![\w$.])from\s*${QUOTED}`, "g") },
  { kind: "static", pattern: new RegExp(String.raw`(?<![\w$.])import\s*${QUOTED}`, "g") },
  { kind: "dynamic", pattern: new RegExp(String.raw`(?<![\w$.])import\s*${CALL_ARGUMENT}`, "g") },
  { kind: "require", pattern: new RegExp(String.raw`(?<![\w$.])require\s*${CALL_ARGUMENT}`, "g") },
  { kind: "resolve", pattern: new RegExp(String.raw`(?<![\w$.])import\.meta\.resolve\s*${CALL_ARGUMENT}`, "g") },
];

// Under verbatimModuleSyntax only `import type` and `export type` heads are erased whole.
const STATEMENT_HEAD = /(?<![\w$.])(?:import|export)(?![\w$])(?!\s*[.(])/g;
const TYPE_ONLY_HEAD = /^(?:import|export)\s+type\s*[{*]/;

function isTypeOnlyStatement(code, headIndex) {
  return TYPE_ONLY_HEAD.test(code.slice(headIndex));
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Every module the text names in code, in order, at the line its statement or call starts.
 * A computed specifier and a `require` under another name are not read. */
export function importsIn(text) {
  const code = codeOnly(text);
  const heads = [...code.matchAll(STATEMENT_HEAD)].map((head) => head.index);
  const found = [];
  for (const { kind, pattern } of FORMS) {
    for (const match of code.matchAll(pattern)) {
      const close = match.index + match[0].length - 1;
      const open = match.index + match[0].search(/["'`]/);
      // A `from` belongs to the statement whose head comes last before it.
      const headIndex = match[0].startsWith("from")
        ? (heads.findLast((head) => head < match.index) ?? match.index)
        : match.index;
      found.push({
        at: headIndex,
        specifier: text.slice(open + 1, close),
        line: lineAt(text, headIndex),
        kind,
        typeOnly: kind === "static" && isTypeOnlyStatement(code, headIndex),
      });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at, ...entry }) => entry);
}
