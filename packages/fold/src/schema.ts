export const KERNEL_INDEX_TABLES: ReadonlyMap<string, readonly string[]> = new Map([
  // One statement per element: an engine may run a text's first statement and drop the rest.
  [
    "schema_meta",
    [
      `CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        version INTEGER NOT NULL,
        admission TEXT,
        through TEXT,
        trust TEXT
      );`,
    ],
  ],
  [
    "watermark",
    [
      `CREATE TABLE watermark (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        commit_sha TEXT
      );`,
    ],
  ],
  [
    "walked",
    [
      `CREATE TABLE walked (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        commit_sha TEXT
      );`,
    ],
  ],
  [
    "commits",
    [
      `CREATE TABLE commits (
        sha TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        committed_at TEXT NOT NULL
      );`,
    ],
  ],
  [
    "records",
    [
      `CREATE TABLE records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        position INTEGER NOT NULL
      );`,
      "CREATE INDEX records_by_kind ON records (kind);",
    ],
  ],
  [
    "claims",
    [
      `CREATE TABLE claims (
        slot TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        rendering TEXT NOT NULL,
        exclusive_group TEXT,
        record_json TEXT NOT NULL,
        PRIMARY KEY (slot, id)
      );`,
      "CREATE INDEX claims_by_exclusive_group ON claims (exclusive_group);",
    ],
  ],
  [
    "evidence_edges",
    [
      `CREATE TABLE evidence_edges (
        claim_slot TEXT NOT NULL,
        record_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        selector TEXT NOT NULL,
        selector_module TEXT NOT NULL,
        selector_parser TEXT NOT NULL,
        selector_version TEXT NOT NULL,
        selector_key TEXT NOT NULL,
        item TEXT NOT NULL
      );`,
      "CREATE INDEX evidence_edges_by_slot ON evidence_edges (claim_slot);",
      "CREATE INDEX evidence_edges_by_record ON evidence_edges (record_id);",
    ],
  ],
  [
    "rulings",
    [
      `CREATE TABLE rulings (
        id TEXT PRIMARY KEY,
        claim_id TEXT,
        over_type TEXT,
        over_scope_json TEXT,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX rulings_by_claim ON rulings (claim_id);",
      "CREATE INDEX rulings_by_type ON rulings (over_type);",
    ],
  ],
  [
    "rules",
    [
      `CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        contribution TEXT,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX rules_by_contribution ON rules (contribution);",
    ],
  ],
  [
    "arguments",
    [
      `CREATE TABLE arguments (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX arguments_by_target ON arguments (target);",
    ],
  ],
  [
    "refusals",
    [
      `CREATE TABLE refusals (
        commit_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        id TEXT,
        reason TEXT NOT NULL,
        PRIMARY KEY (commit_sha, path)
      );`,
      "CREATE INDEX refusals_by_id ON refusals (id);",
    ],
  ],
  [
    "module_contributions",
    [
      `CREATE TABLE module_contributions (
        module_record TEXT NOT NULL,
        module_name TEXT NOT NULL,
        module_version TEXT NOT NULL,
        contribution_id TEXT NOT NULL,
        contribution_version TEXT NOT NULL,
        contribution_kind TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (module_record, contribution_id, contribution_version)
      );`,
    ],
  ],
  [
    "receipts",
    [
      `CREATE TABLE receipts (
        recipe_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (recipe_id, record_id)
      );`,
    ],
  ],
  [
    "artifact_anchors",
    [
      `CREATE TABLE artifact_anchors (
        artifact_id TEXT NOT NULL,
        label TEXT NOT NULL,
        full_id TEXT NOT NULL,
        PRIMARY KEY (artifact_id, label)
      );`,
    ],
  ],
  [
    "reads",
    [
      `CREATE TABLE reads (
        reader TEXT NOT NULL,
        key TEXT NOT NULL,
        consumed_json TEXT NOT NULL,
        PRIMARY KEY (reader, key)
      );`,
      "CREATE INDEX reads_by_key ON reads (key);",
    ],
  ],
  [
    "succession",
    [
      `CREATE TABLE succession (
        predecessor TEXT NOT NULL,
        successor TEXT NOT NULL,
        successor_kind TEXT NOT NULL,
        PRIMARY KEY (predecessor, successor)
      );`,
      "CREATE INDEX succession_by_successor ON succession (successor);",
    ],
  ],
  [
    "cases",
    [
      `CREATE TABLE cases (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX cases_by_slug ON cases (slug);",
    ],
  ],
  [
    "case_claims",
    [
      `CREATE TABLE case_claims (
        case_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        PRIMARY KEY (case_id, claim_id)
      );`,
      "CREATE INDEX case_claims_by_claim ON case_claims (claim_id);",
    ],
  ],
  [
    "artifacts",
    [
      `CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX artifacts_by_case ON artifacts (case_id);",
    ],
  ],
  [
    "attestations",
    [
      `CREATE TABLE attestations (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        principal TEXT NOT NULL,
        purpose TEXT NOT NULL,
        record_json TEXT NOT NULL
      );`,
      "CREATE INDEX attestations_by_subject ON attestations (subject);",
      "CREATE INDEX attestations_by_principal ON attestations (principal);",
      "CREATE INDEX attestations_by_purpose ON attestations (purpose);",
    ],
  ],
  [
    "fold_tables",
    [
      `CREATE TABLE fold_tables (
        name TEXT PRIMARY KEY,
        contribution_id TEXT NOT NULL UNIQUE,
        module_record TEXT NOT NULL,
        version TEXT NOT NULL,
        ddl TEXT NOT NULL
      );`,
    ],
  ],
  [
    "fold_refusals",
    [
      `CREATE TABLE fold_refusals (
        name TEXT PRIMARY KEY,
        contribution_id TEXT NOT NULL UNIQUE,
        module_record TEXT NOT NULL,
        version TEXT NOT NULL,
        reason TEXT NOT NULL
      );`,
    ],
  ],
  [
    "events",
    [
      `CREATE TABLE events (
        commit_sha TEXT NOT NULL,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        about TEXT NOT NULL,
        record_id TEXT NOT NULL,
        PRIMARY KEY (commit_sha, position)
      );`,
      "CREATE INDEX events_by_about ON events (about);",
    ],
  ],
]);

/** The kernel tables a contributed statement may read: all but the fold's account of itself. */
export const QUERYABLE_KERNEL_TABLES: ReadonlySet<string> = new Set(
  [...KERNEL_INDEX_TABLES.keys()].filter(
    (name) =>
      name !== "schema_meta" &&
      name !== "watermark" &&
      name !== "walked" &&
      name !== "fold_tables" &&
      name !== "fold_refusals" &&
      name !== "refusals",
  ),
);

/** Every identifier the kernel renders into DDL passes this, so none is ever quoted or escaped. */
export function isSafeSqlIdentifier(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name);
}
