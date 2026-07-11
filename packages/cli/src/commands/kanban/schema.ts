import type { OutputSchema } from "../../output/index.js";
import type { KanbanCardRow, KanbanSourceRow } from "./shared.js";
import type { StoredKanbanCard } from "./types.js";

export const kanbanCardSchema: OutputSchema<KanbanCardRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "TITLE", field: "title", width: 30 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "THEME", field: "theme", width: 12 },
    { header: "PRIORITY", field: "priority", width: 10 },
    { header: "LABELS", field: "labels", width: 20 },
    { header: "URL", field: "url", width: 30 },
  ],
};

export interface KanbanCardInspectRow {
  key: string;
  value: string;
}

export function createKanbanCardInspectSchema(
  card: StoredKanbanCard,
): OutputSchema<KanbanCardInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => card,
  };
}

export function createKanbanCardInspectRows(card: StoredKanbanCard): KanbanCardInspectRow[] {
  return [
    { key: "Id", value: card.id },
    { key: "Title", value: card.title },
    { key: "Url", value: card.url ?? "null" },
    { key: "Status", value: card.status },
    { key: "Theme", value: card.theme },
    { key: "Source", value: card.source.kind },
    { key: "ExternalId", value: card.externalId ?? "null" },
    { key: "Order", value: `${card.order}` },
    { key: "StatusPinnedByUser", value: `${card.statusPinnedByUser}` },
    { key: "Labels", value: card.labels && card.labels.length > 0 ? card.labels.join(",") : "" },
    { key: "Assignee", value: card.assignee ?? "null" },
    { key: "Priority", value: card.priority ?? "null" },
    { key: "CreatedAt", value: card.createdAt },
    { key: "UpdatedAt", value: card.updatedAt },
  ];
}

export const kanbanSourceSchema: OutputSchema<KanbanSourceRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "KIND", field: "kind", width: 10 },
    { header: "NAME", field: "name", width: 20 },
    { header: "BASE URL", field: "baseUrl", width: 30 },
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "LAST SYNC", field: "lastSyncAt", width: 24 },
    { header: "LAST ERROR", field: "lastSyncError", width: 24 },
  ],
};
