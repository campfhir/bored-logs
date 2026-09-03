import { Kysely } from "kysely";
import type { ResolvedLogSchema } from "./schema";

/**
 * Replaces the misleadingly-named `attr_val_name_idx` — which actually indexed
 * the attribute *value* (log_attr.val) — with `log_attr_val_name_idx` on the
 * attribute *key* (log_attr.val_name).
 *
 * Indexing raw values was both fragile (btree rows cap at ~2704 bytes, so large
 * multibyte / encrypted values could not be inserted) and largely unused: the
 * value filters in _fetchMatchingIds are mostly `LIKE '%…%'` and numeric casts
 * that a plain btree can't serve. Attribute lookups always filter by key first
 * (`WHERE val_name = …`), so the key column is what's worth indexing.
 *
 * Idempotent — safe to run on every startup.
 */
export async function up(db: Kysely<any>, names: ResolvedLogSchema): Promise<void> {
  await db.schema.dropIndex(names.indexes.attrValName).ifExists().execute();

  await db.schema
    .createIndex(names.indexes.logAttrValName)
    .ifNotExists()
    .on("log_attr")
    .column("val_name")
    .execute();
}

/**
 * Reverses {@link up}: drops `log_attr_val_name_idx` and restores the original
 * 001 `attr_val_name_idx` on the value column. Idempotent.
 */
export async function down(db: Kysely<any>, names: ResolvedLogSchema): Promise<void> {
  await db.schema.dropIndex(names.indexes.logAttrValName).ifExists().execute();

  // Restore the original 001 index on the value column.
  await db.schema
    .createIndex(names.indexes.attrValName)
    .ifNotExists()
    .on("log_attr")
    .column("val")
    .execute();
}
