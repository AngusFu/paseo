import type {
  CreateKanbanCardInput,
  CreateKanbanSourceInput,
  KanbanPriority,
  KanbanStatus,
  MoveKanbanCardInput,
  StoredKanbanCard,
  StoredKanbanSource,
  UpdateKanbanCardInput,
  UpdateKanbanSourceInput,
} from "@getpaseo/protocol/kanban/types";

export type { KanbanPriority, KanbanStatus, StoredKanbanCard, StoredKanbanSource };

export interface KanbanCardCreatePayload {
  requestId: string;
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardListPayload {
  requestId: string;
  cards: StoredKanbanCard[];
  error: string | null;
}

export interface KanbanCardInspectPayload {
  requestId: string;
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardUpdatePayload {
  requestId: string;
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardMovePayload {
  requestId: string;
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardDeletePayload {
  requestId: string;
  cardId: string;
  error: string | null;
}

export interface KanbanSourceCreatePayload {
  requestId: string;
  source: StoredKanbanSource | null;
  error: string | null;
}

export interface KanbanSourceListPayload {
  requestId: string;
  sources: StoredKanbanSource[];
  error: string | null;
}

export interface KanbanSourceSyncPayload {
  requestId: string;
  source: StoredKanbanSource | null;
  cards: StoredKanbanCard[];
  upsertedCount: number;
  error: string | null;
}

// Structural subset of DaemonClient consumed by the kanban CLI commands.
// Mirrors schedule/types.ts ScheduleDaemonClient.
export interface KanbanDaemonClient {
  kanbanCardCreate(
    options: CreateKanbanCardInput & { requestId?: string },
  ): Promise<KanbanCardCreatePayload>;
  kanbanCardList(requestId?: string): Promise<KanbanCardListPayload>;
  kanbanCardInspect(cardId: string, requestId?: string): Promise<KanbanCardInspectPayload>;
  kanbanCardUpdate(
    options: UpdateKanbanCardInput & { requestId?: string },
  ): Promise<KanbanCardUpdatePayload>;
  kanbanCardMove(
    options: MoveKanbanCardInput & { requestId?: string },
  ): Promise<KanbanCardMovePayload>;
  kanbanCardDelete(cardId: string, requestId?: string): Promise<KanbanCardDeletePayload>;
  kanbanSourceCreate(
    options: CreateKanbanSourceInput & { requestId?: string },
  ): Promise<KanbanSourceCreatePayload>;
  kanbanSourceList(requestId?: string): Promise<KanbanSourceListPayload>;
  kanbanSourceUpdate(
    options: UpdateKanbanSourceInput & { requestId?: string },
  ): Promise<KanbanSourceCreatePayload>;
  kanbanSourceSync(sourceId: string, requestId?: string): Promise<KanbanSourceSyncPayload>;
  close(): Promise<void>;
}
