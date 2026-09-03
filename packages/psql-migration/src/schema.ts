/**
 * Configurable placement of the log tables: a dedicated Postgres schema, a
 * name prefix, and/or explicit per-table names — so the adapter can be added
 * to an existing database without colliding with its tables.
 *
 * The adapter and the migrations are written against LOGICAL table names
 * (`logs`, `log_attr`, …). {@link LogSchemaPlugin} rewrites those identifiers
 * to their physical names at query-compile time, so a single code path serves
 * every layout and the default layout compiles to exactly the SQL it always
 * has (the plugin is not even attached when nothing is customised).
 *
 * @module
 */
import {
  IdentifierNode,
  OperationNodeTransformer,
  type DropIndexNode,
  type Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type ReferenceNode,
  type RootOperationNode,
  type SchemableIdentifierNode,
  type UnknownRow,
} from "kysely";

// ---------------------------------------------------------------------------
// Options + resolution
// ---------------------------------------------------------------------------

/** The logical (code-facing) names of every table the adapter uses. */
export const LOG_TABLE_KEYS = [
  "logs",
  "log_attr",
  "log_attr_blob",
  "log_purge_job",
  "log_purge_ids",
  "log_e2e_clients",
] as const;

/** A logical table name — the keys of `LoggerTables` in the adapter. */
export type LogTableKey = (typeof LOG_TABLE_KEYS)[number];

/** Where and under what names the log tables live. Every field is optional; the defaults reproduce the pre-0.8 layout. */
export type LogSchemaOptions = {
  /**
   * Postgres schema that holds the log tables. Migration `001_logs` creates
   * it (`CREATE SCHEMA IF NOT EXISTS`); rollback never drops it. When unset,
   * tables are created in and resolved from the connection's `search_path`.
   */
  schema?: string;
  /**
   * Prefix prepended to every table, index, and constraint name — e.g.
   * `"bl_"` yields `bl_logs`, `bl_log_attr`, `bl_log_timestamp_idx`. This is
   * the option to use when two installations must share one schema, because
   * it keeps their index names distinct as well.
   */
  tablePrefix?: string;
  /**
   * Explicit physical names per logical table, applied after the prefix.
   * Index and constraint names are NOT derived from these — combine with
   * `tablePrefix` (or `schema`) to isolate a second installation.
   */
  tables?: Partial<Record<LogTableKey, string>>;
};

/** Every physical identifier the migrations and the adapter need, fully resolved. */
export type ResolvedLogSchema = {
  /** The configured schema, or `undefined` for the search_path. */
  schema: string | undefined;
  /** The configured `tablePrefix` (`""` when unset). */
  prefix: string;
  /** Logical → physical table name. */
  tables: Record<LogTableKey, string>;
  /** Index names (prefixed). `attrValName` is the 001 index that 002 replaces with `logAttrValName`. */
  indexes: {
    logTimestamp: string;
    attrLogTimestamp: string;
    attrLog: string;
    attrValName: string;
    logAttrValName: string;
    logLevel: string;
  };
  /** Named constraints (prefixed). */
  constraints: {
    logPurgeIdsPkey: string;
  };
  /** True when nothing was customised — the identity layout, no plugin needed. */
  isDefault: boolean;
};

// Unquoted-safe Postgres identifier: lowercase so Kysely's double-quoting
// never changes case semantics, ≤ 63 bytes (NAMEDATALEN - 1).
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function assertIdentifier(kind: string, value: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(
      `[bored-logs] invalid ${kind} "${value}": must match ${IDENT_RE} (lowercase letters, digits, underscores; at most 63 characters)`,
    );
  }
}

/**
 * Resolve {@link LogSchemaOptions} to concrete identifiers. Throws on an
 * identifier that is not a plain lowercase Postgres name.
 */
export function resolveLogSchema(options: LogSchemaOptions = {}): ResolvedLogSchema {
  const prefix = options.tablePrefix ?? "";
  const schema = options.schema || undefined;
  if (schema) assertIdentifier("schema", schema);
  if (prefix && !/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`[bored-logs] invalid tablePrefix "${prefix}": lowercase letters, digits, underscores only`);
  }

  const tables = {} as Record<LogTableKey, string>;
  for (const key of LOG_TABLE_KEYS) {
    const override = options.tables?.[key];
    if (override !== undefined) assertIdentifier(`tables.${key}`, override);
    tables[key] = override ?? `${prefix}${key}`;
    assertIdentifier(`table name for ${key}`, tables[key]);
  }
  const seen = new Map<string, LogTableKey>();
  for (const key of LOG_TABLE_KEYS) {
    const dup = seen.get(tables[key]);
    if (dup) throw new Error(`[bored-logs] tables.${key} and tables.${dup} both resolve to "${tables[key]}"`);
    seen.set(tables[key], key);
  }

  const p = (name: string) => {
    assertIdentifier("index or constraint name", `${prefix}${name}`);
    return `${prefix}${name}`;
  };
  const isDefault = !schema && !prefix && LOG_TABLE_KEYS.every((k) => tables[k] === k);

  return {
    schema,
    prefix,
    tables,
    indexes: {
      logTimestamp: p("log_timestamp_idx"),
      attrLogTimestamp: p("attr_log_timestamp_idx"),
      attrLog: p("attr_log_idx"),
      attrValName: p("attr_val_name_idx"),
      logAttrValName: p("log_attr_val_name_idx"),
      logLevel: p("log_level_idx"),
    },
    constraints: {
      logPurgeIdsPkey: p("log_purge_ids_pkey"),
    },
    isDefault,
  };
}

// ---------------------------------------------------------------------------
// Kysely plugin — logical → physical identifier rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrites every logical log-table identifier in a query tree to its physical
 * name, schema-qualifying table positions (FROM / INTO / UPDATE / DELETE /
 * CREATE / DROP / REFERENCES / `sql.table()`) and `DROP INDEX` names, while
 * column references (`logs.log_id`, `sql.ref("log_attr.val")`) get only the
 * rename — they resolve against the already-qualified FROM item.
 */
class LogSchemaTransformer extends OperationNodeTransformer {
  readonly #schema: string | undefined;
  readonly #tables: ReadonlyMap<string, string>;
  #referenceDepth = 0;

  constructor(names: ResolvedLogSchema) {
    super();
    this.#schema = names.schema;
    this.#tables = new Map(LOG_TABLE_KEYS.map((k) => [k, names.tables[k]]));
  }

  protected override transformSchemableIdentifier(node: SchemableIdentifierNode): SchemableIdentifierNode {
    const transformed = super.transformSchemableIdentifier(node);
    const physical = this.#tables.get(transformed.identifier.name);
    if (physical === undefined || transformed.schema) return transformed;
    const qualify = this.#schema !== undefined && this.#referenceDepth === 0;
    return {
      ...transformed,
      identifier: IdentifierNode.create(physical),
      schema: qualify ? IdentifierNode.create(this.#schema!) : undefined,
    };
  }

  protected override transformReference(node: ReferenceNode): ReferenceNode {
    this.#referenceDepth++;
    try {
      return super.transformReference(node);
    } finally {
      this.#referenceDepth--;
    }
  }

  protected override transformDropIndex(node: DropIndexNode): DropIndexNode {
    const transformed = super.transformDropIndex(node);
    if (this.#schema === undefined || transformed.name.schema) return transformed;
    // Indexes live in their table's schema; DROP INDEX must name it explicitly.
    return {
      ...transformed,
      name: { ...transformed.name, schema: IdentifierNode.create(this.#schema) },
    };
  }
}

/** A {@link KyselyPlugin} applying a {@link ResolvedLogSchema} to every query. Attach with `db.withPlugin(...)` or via {@link withLogSchema}. */
export class LogSchemaPlugin implements KyselyPlugin {
  readonly #transformer: LogSchemaTransformer;

  constructor(names: ResolvedLogSchema) {
    this.#transformer = new LogSchemaTransformer(names);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

/**
 * The `db` to run log queries and migrations through: the original instance
 * for the default layout, or a copy with a {@link LogSchemaPlugin} attached.
 * The returned instance shares the connection pool; plugins carry into
 * `db.transaction()`.
 */
export function withLogSchema<DB>(db: Kysely<DB>, options?: LogSchemaOptions | ResolvedLogSchema): Kysely<DB> {
  const names = isResolved(options) ? options : resolveLogSchema(options);
  return names.isDefault ? db : db.withPlugin(new LogSchemaPlugin(names));
}

function isResolved(o: LogSchemaOptions | ResolvedLogSchema | undefined): o is ResolvedLogSchema {
  return !!o && "isDefault" in o && "indexes" in o;
}
