import { openIndexProvider } from "@musai/fold";

/** Every row of every table at `path`, so two folds compare by content, not by page layout. */
export function rowsHeld(path: string): Record<string, string[]> {
  const db = openIndexProvider().openReadOnly(path);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort(),
      ]),
    );
  } finally {
    db.close();
  }
}
