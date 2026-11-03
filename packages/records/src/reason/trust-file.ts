import { KernelError } from "./error.js";

export const CONFIG_FILE = "config.json";

export const ALLOWED_SIGNERS_FILE = "allowed-signers";

export const ROLES_FILE = "roles";

export const AUDIENCES_FILE = "audiences";

/** A trust-branch file a reader cannot take, refused with what to change there, so a surface
 * reports a workspace to fix and `doctor` lists them though the open refuses. */
export class TrustFileError extends KernelError {
  readonly file: string;
  /** Counted from one; null where the refusal is of a configuration key or the whole file. */
  readonly line: number | null;
  /** What is wrong, without the remedy, for a caller judging a value before it is written. */
  readonly problem: string;

  private constructor(
    file: string,
    line: number | null,
    about: string,
    problem: string,
    remedy: string,
    cause?: unknown,
  ) {
    super({
      reason: "workspace-incomplete",
      about: [about],
      detail: `${problem}; ${remedy} on the trust branch`,
      cause,
    });
    this.name = "TrustFileError";
    this.file = file;
    this.line = line;
    this.problem = problem;
  }

  static atLine(file: string, index: number, problem: string, text: string): TrustFileError {
    const line = index + 1;
    return new TrustFileError(
      file,
      line,
      file,
      `${file} holds ${problem} at line ${line}: ${text}`,
      `fix or remove line ${line} of ${file}`,
    );
  }

  static atKey(key: string, problem: string): TrustFileError {
    return new TrustFileError(CONFIG_FILE, null, key, problem, `fix or remove ${key} in ${CONFIG_FILE}`);
  }

  static whole(file: string, problem: string, cause?: unknown): TrustFileError {
    return new TrustFileError(file, null, file, problem, `fix ${file}`, cause);
  }
}
