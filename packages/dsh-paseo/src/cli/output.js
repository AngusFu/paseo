// CLI output layer — paseo-aligned: table (default) / json / yaml / quiet.
// Reference: paseo packages/cli/src/output/ (table, json, yaml, quiet).

import { dump as dumpYaml } from "js-yaml";

/**
 * Render rows as an aligned table. Column widths derive from content; values
 * are truncated to the column width when one is given.
 * @param {Array<Record<string, unknown>>} rows
 * @param {Array<{header: string, field: string, width?: number}>} columns
 * @returns {string}
 */
export function renderTable(rows, columns) {
  const cells = rows.map((row) => columns.map((col) => String(row[col.field] ?? "")));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((row) => row[i].length)),
  );
  const fmt = (row) =>
    row
      .map((cell, i) => {
        const w = columns[i].width ?? widths[i];
        const v = cell.length > w ? `${cell.slice(0, w - 1)}…` : cell;
        return v.padEnd(widths[i]);
      })
      .join("  ")
      .trimEnd();
  const lines = [fmt(columns.map((col) => col.header))];
  if (rows.length > 0) lines.push(...cells.map(fmt));
  return lines.join("\n");
}

export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

export function renderYaml(value) {
  return dumpYaml(value);
}

/**
 * Quiet mode: one id per line.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} idField
 * @returns {string}
 */
export function renderQuiet(rows, idField) {
  return rows.map((row) => String(row[idField] ?? "")).join("\n");
}
