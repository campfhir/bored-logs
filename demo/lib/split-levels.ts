import type { FilterExpr } from "@campfhir/bored-logs";
import { LOG_LEVELS } from "@campfhir/bored-logs";

const isKnownLevel = (name: string): boolean => name.toLowerCase() in LOG_LEVELS;

/**
 * `level` is a first-class column with its own query option — not a value
 * stored in `log_attr` — so it must not go through `attributeFilter` (that
 * would search a non-existent `level` attribute and match nothing).
 *
 * Lift the top-level (AND-ed) `level:` chips out of the parsed tree into a
 * `levels` list for `query({ levels })`, and keep the rest of the tree as the
 * attribute filter. Several level chips read as "any of" (the level IN(…)
 * clause) — the friendly reading of `level:'info' level:'error'`.
 *
 * Only simple positive `=` / contains level leaves whose value is a known
 * level are lifted. A `level:` term nested inside an OR group, negated, or with
 * an unknown value is left in the tree untouched.
 */
export function splitLevelTerms(expr: FilterExpr | null): {
  levels: string[];
  filter: FilterExpr | null;
} {
  if (!expr || expr.type !== "and") return { levels: [], filter: expr };

  const levels: string[] = [];
  const kept: FilterExpr[] = [];

  for (const branch of expr.nodes) {
    // A level chip is a single filter leaf, or an `or` wrapping exactly one.
    const leaf =
      branch.type === "filter"
        ? branch.filter
        : branch.type === "or" && branch.nodes.length === 1 && branch.nodes[0].type === "filter"
          ? branch.nodes[0].filter
          : null;

    if (
      leaf &&
      leaf.key === "level" &&
      !leaf.negated &&
      (leaf.operator === "contains" || leaf.operator === "=") &&
      isKnownLevel(leaf.value)
    ) {
      levels.push(leaf.value);
    } else {
      kept.push(branch);
    }
  }

  return { levels, filter: kept.length ? { type: "and", nodes: kept } : null };
}
