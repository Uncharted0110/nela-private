// Schema key repair operates on loosely-typed LLM JSON.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function repairNestedKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(repairNestedKeys);
  }

  const repaired: any = {};
  for (const key of Object.keys(obj)) {
    let newKey = key;
    const lower = key.toLowerCase();

    // Map common misspellings of functional schema keys
    if (
      lower === "column" ||
      lower === "col_name" ||
      lower === "target_col" ||
      lower === "cols" ||
      lower === "colname"
    ) {
      newKey = "col";
    } else if (
      lower === "group" ||
      lower === "group_column" ||
      lower === "groupcol" ||
      lower === "by_col" ||
      lower === "group_by" ||
      lower === "by"
    ) {
      newKey = "group_col";
    } else if (
      lower === "value" ||
      lower === "value_column" ||
      lower === "val_col" ||
      lower === "valcol" ||
      lower === "val"
    ) {
      newKey = "value_col";
    } else if (lower === "row_column" || lower === "rowcol") {
      newKey = "row_col";
    } else if (lower === "column_column" || lower === "column_col" || lower === "colcol") {
      newKey = "col_col";
    } else if (lower === "expression" || lower === "expr" || lower === "calc") {
      newKey = "formula";
    }

    repaired[newKey] = repairNestedKeys(obj[key]);
  }

  // Operation-specific structural repair
  if (repaired.op) {
    const op = String(repaired.op).toUpperCase();
    repaired.op = op; // Ensure uppercase

    if (op === "COUNT_BY_GROUP") {
      if (repaired.col && !repaired.group_col) {
        repaired.group_col = repaired.col;
        delete repaired.col;
      }
    } else if (op === "AVERAGE_BY_GROUP") {
      if (repaired.col && !repaired.group_col) {
        repaired.group_col = repaired.col;
        delete repaired.col;
      }
    } else if (
      op === "SUM_COLUMN" ||
      op === "SORT_DESC" ||
      op === "SORT_ASC" ||
      op === "FILTER_ROWS"
    ) {
      if (repaired.group_col && !repaired.col) {
        repaired.col = repaired.group_col;
        delete repaired.group_col;
      }
    }
  }

  return repaired;
}
