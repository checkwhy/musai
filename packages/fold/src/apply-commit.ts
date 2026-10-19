import type { ArtifactRecord, RunRecord } from "@musai/records";
import {
  type EventKind,
  eventKindForRecordKind,
  isSealedValue,
  parseReceiptsSection,
  type RecordId,
  recordId,
  renderedTextOf,
  renderSelector,
} from "@musai/records";
import { type FoldRow, type FoldTable, rowStatementsFor } from "./fold-extension.js";
import type { ContributedRows, FoldedRecord, FoldInterruptEvent, RefusedRecordPath } from "./rows.js";
import type { IndexConnection } from "./sqlite-provider.js";

interface FoldedCommit {
  sha: string;
  committedAt: string;
}

/** A deterministic run carries no instant, so it orders by the commit that landed it. */
function startedAtOf(run: RunRecord, commit: FoldedCommit): string {
  return ("startedAt" in run.observation ? run.observation.startedAt : undefined) ?? commit.committedAt;
}

export function applyCommit(
  db: IndexConnection,
  commit: FoldedCommit,
  added: readonly FoldedRecord[],
  refused: readonly RefusedRecordPath[],
  contributed: readonly ContributedRows[],
  onStep?: (event: FoldInterruptEvent) => void,
): void {
  db.exec("SAVEPOINT fold_commit");
  try {
    // Replaying an applied commit is a no-op; seq read here matches a fold from the root.
    db.prepare(
      "INSERT INTO commits (sha, seq, committed_at) " +
        "VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM commits), ?) ON CONFLICT(sha) DO NOTHING",
    ).run(commit.sha, commit.committedAt);
    for (const refusal of refused) {
      db.prepare(
        "INSERT INTO refusals (commit_sha, path, id, reason) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(commit_sha, path) DO UPDATE SET id = excluded.id, reason = excluded.reason",
      ).run(commit.sha, refusal.path, refusal.id, refusal.reason);
    }
    for (const { id, record, position } of added) {
      // A record belongs to the first commit that holds it; a later re-add does not move it.
      const landed = db
        .prepare(
          "INSERT INTO records (id, kind, schema_version, record_json, commit_sha, position) " +
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, record.kind, record.schemaVersion, JSON.stringify(record), commit.sha, position);
      // Only the landing sighting raises an event; log order keeps cold and warm folds equal.
      const eventKind = eventKindForRecordKind(record.kind);
      if (eventKind !== undefined && landed.changes > 0) {
        const about = record.kind === "module" ? record.name : id;
        const pinned =
          record.kind === "module" &&
          db
            .prepare("SELECT 1 FROM events WHERE about = ? AND kind IN ('module.installed', 'pin.changed') LIMIT 1")
            .get(about) !== undefined;
        const kind: EventKind = pinned ? "pin.changed" : eventKind;
        db.prepare(
          "INSERT INTO events (commit_sha, position, kind, about, record_id) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(commit_sha, position) DO NOTHING",
        ).run(commit.sha, position, kind, about, id);
      }
      for (const predecessor of record.supersedes) {
        db.prepare(
          "INSERT INTO succession (predecessor, successor, successor_kind) VALUES (?, ?, ?) " +
            "ON CONFLICT(predecessor, successor) DO NOTHING",
        ).run(predecessor, id, record.kind);
      }
      if (record.kind === "claim") {
        db.prepare(
          "INSERT INTO claims (slot, id, type, rendering, exclusive_group, record_json) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slot, id) DO UPDATE SET type = excluded.type, " +
            "rendering = excluded.rendering, exclusive_group = excluded.exclusive_group, record_json = excluded.record_json",
        ).run(
          record.slot,
          id,
          record.type,
          renderedTextOf(record.rendering),
          record.exclusiveGroup,
          JSON.stringify(record),
        );
        db.prepare("DELETE FROM evidence_edges WHERE claim_slot = ? AND record_id = ?").run(record.slot, id);
        for (const edge of record.evidence) {
          db.prepare(
            "INSERT INTO evidence_edges " +
              "(claim_slot, record_id, run_id, selector, selector_module, selector_parser, selector_version, selector_key, item) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            record.slot,
            id,
            edge.run,
            renderSelector(edge.selector),
            edge.selector.module,
            edge.selector.parser,
            edge.selector.version,
            edge.selector.key,
            edge.item,
          );
        }
      } else if (record.kind === "ruling") {
        const over = record.over;
        const boundToClaim = "claim" in over;
        db.prepare(
          "INSERT INTO rulings (id, claim_id, over_type, over_scope_json, record_json) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET claim_id = excluded.claim_id, over_type = excluded.over_type, " +
            "over_scope_json = excluded.over_scope_json, record_json = excluded.record_json",
        ).run(
          id,
          boundToClaim ? over.claim : null,
          boundToClaim ? null : over.type,
          boundToClaim ? null : JSON.stringify(over.scope),
          JSON.stringify(record),
        );
      } else if (record.kind === "rule") {
        db.prepare(
          "INSERT INTO rules (id, contribution, record_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET contribution = excluded.contribution, record_json = excluded.record_json",
        ).run(id, record.contribution, JSON.stringify(record));
      } else if (record.kind === "argument") {
        db.prepare(
          "INSERT INTO arguments (id, target, record_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET target = excluded.target, record_json = excluded.record_json",
        ).run(id, record.target, JSON.stringify(record));
      } else if (record.kind === "run") {
        const recipeIdValue = recordId(record.recipe);
        db.prepare(
          "INSERT INTO receipts (recipe_id, record_id, started_at, record_json) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(recipe_id, record_id) DO UPDATE SET started_at = excluded.started_at, record_json = excluded.record_json",
        ).run(recipeIdValue, id, startedAtOf(record, commit), JSON.stringify(record));
        for (const read of record.observation.reads) {
          db.prepare(
            "INSERT INTO reads (reader, key, consumed_json) VALUES (?, ?, ?) " +
              "ON CONFLICT(reader, key) DO UPDATE SET consumed_json = excluded.consumed_json",
          ).run(id, read.key, JSON.stringify(read.consumed));
        }
      } else if (record.kind === "artifact") {
        const artifact = record as ArtifactRecord;
        db.prepare(
          "INSERT INTO artifacts (id, case_id, record_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET case_id = excluded.case_id, record_json = excluded.record_json",
        ).run(id, artifact.case, JSON.stringify(record));
        db.prepare("DELETE FROM artifact_anchors WHERE artifact_id = ?").run(id);
        // A sealed artifact's receipts section is ciphertext, so it anchors nothing.
        const anchored = isSealedValue(artifact.content) ? "" : artifact.content;
        for (const [label, fullId] of parseReceiptsSection(anchored)) {
          db.prepare("INSERT INTO artifact_anchors (artifact_id, label, full_id) VALUES (?, ?, ?)").run(
            id,
            label,
            fullId,
          );
        }
      } else if (record.kind === "module") {
        for (const entry of record.manifest.contributions) {
          db.prepare(
            "INSERT INTO module_contributions " +
              "(module_record, module_name, module_version, contribution_id, contribution_version, contribution_kind, entry_json) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(module_record, contribution_id, contribution_version) DO UPDATE SET " +
              "module_name = excluded.module_name, module_version = excluded.module_version, " +
              "contribution_kind = excluded.contribution_kind, entry_json = excluded.entry_json",
          ).run(id, record.name, record.version, entry.id, entry.version, entry.kind, JSON.stringify(entry));
        }
      } else if (record.kind === "case") {
        db.prepare(
          "INSERT INTO cases (id, slug, record_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, record_json = excluded.record_json",
        ).run(id, record.slug, JSON.stringify(record));
        db.prepare("DELETE FROM case_claims WHERE case_id = ?").run(id);
        for (const claimId of record.claims) {
          db.prepare(
            "INSERT INTO case_claims (case_id, claim_id) VALUES (?, ?) " + "ON CONFLICT(case_id, claim_id) DO NOTHING",
          ).run(id, claimId);
        }
      } else if (record.kind === "attestation") {
        db.prepare(
          "INSERT INTO attestations (id, subject, principal, purpose, record_json) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, principal = excluded.principal, " +
            "purpose = excluded.purpose, record_json = excluded.record_json",
        ).run(id, record.subject, record.principal, record.purpose, JSON.stringify(record));
      }
    }
    for (const { table, record, rows } of contributed) {
      writeContributedRows(db, table, record, rows);
    }
    onStep?.({ commit: commit.sha, phase: "mid-transaction" });
    db.prepare("UPDATE watermark SET commit_sha = ? WHERE id = 0").run(commit.sha);
    db.prepare("UPDATE walked SET commit_sha = ? WHERE id = 0").run(commit.sha);
    db.exec("RELEASE fold_commit");
  } catch (error) {
    db.exec("ROLLBACK TO fold_commit");
    db.exec("RELEASE fold_commit");
    throw error;
  }
}

/** Replaces one record's rows in a contributed table, so re-folding the record is idempotent. */
export function writeContributedRows(
  db: IndexConnection,
  table: FoldTable,
  record: RecordId,
  rows: readonly FoldRow[],
): void {
  const written = rowStatementsFor(table);
  db.prepare(written.remove).run(record);
  const insert = db.prepare(written.insert);
  for (const [ordinal, row] of rows.entries()) {
    insert.run(record, ordinal, ...table.columns.map((column) => row[column.name] ?? null));
  }
}
