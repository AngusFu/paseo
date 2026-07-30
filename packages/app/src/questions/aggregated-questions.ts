import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListPageInfo } from "@getpaseo/protocol/list-page";
import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";
import { toErrorMessage } from "@/utils/error-messages";

export const questionsQueryBaseKey = ["questions"] as const;
export const QUESTIONS_PAGE_LIMIT = 50;

export const ALL_QUESTION_HOSTS_FAILED_MESSAGE = "No connected hosts could load questions";

export type ApprovalsBucket = "pending" | "answered" | "closed";

export interface QuestionHostInput {
  serverId: string;
  serverName: string;
}

export interface QuestionRuntimeSnapshot {
  connectionStatus: string;
}

export interface QuestionRuntime {
  getClient(serverId: string): Pick<DaemonClient, "questionList"> | null;
  getSnapshot(serverId: string): QuestionRuntimeSnapshot | null | undefined;
}

/** An inbox question tagged with the host it came from. */
export interface AggregatedQuestion extends StoredInboxQuestion {
  serverId: string;
  serverName: string;
}

export interface QuestionHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedQuestionsConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedQuestionsResult {
  status: "loaded";
  data: AggregatedQuestion[];
  hostErrors: QuestionHostError[];
  pageInfoByServerId: Record<string, ListPageInfo>;
}

export type FetchAggregatedQuestionsState =
  | FetchAggregatedQuestionsConnectingResult
  | FetchAggregatedQuestionsResult;

export type { AggregateLoadState };

export interface FetchAggregatedQuestionsInput {
  hosts: readonly QuestionHostInput[];
  runtime: QuestionRuntime;
  bucket: ApprovalsBucket;
  cursorByServerId: Record<string, string | null> | null;
}

export function bucketToQuestionListFilter(bucket: ApprovalsBucket): {
  status?: StoredInboxQuestion["status"];
  statuses?: StoredInboxQuestion["status"][];
} {
  if (bucket === "pending") {
    return { status: "pending" };
  }
  if (bucket === "answered") {
    return { status: "answered" };
  }
  return { statuses: ["dismissed", "expired"] };
}

function isQuestionHostConnectionSettling(
  snapshot: QuestionRuntimeSnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}

export async function fetchAggregatedQuestionsPage(
  input: FetchAggregatedQuestionsInput,
): Promise<FetchAggregatedQuestionsState> {
  const isInitialPage = !input.cursorByServerId || Object.keys(input.cursorByServerId).length === 0;
  const cursorByServerId = input.cursorByServerId ?? {};
  const hasCursorFilter = Object.keys(cursorByServerId).length > 0;
  const hostsToFetch = hasCursorFilter
    ? input.hosts.filter((host) => Object.hasOwn(cursorByServerId, host.serverId))
    : input.hosts;

  if (isInitialPage) {
    const hasSettlingHost = input.hosts.some((host) =>
      isQuestionHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
    );
    const hasAskableHost = input.hosts.some((host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
    });

    if (!hasAskableHost && hasSettlingHost) {
      return { status: "connecting" };
    }
  }

  const questions: AggregatedQuestion[] = [];
  const hostErrors: QuestionHostError[] = [];
  const pageInfoByServerId: Record<string, ListPageInfo> = {};
  let connectedAttempts = 0;
  const listFilter = bucketToQuestionListFilter(input.bucket);

  await Promise.all(
    hostsToFetch.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.questionList({
          ...listFilter,
          limit: QUESTIONS_PAGE_LIMIT,
          ...(cursorByServerId[host.serverId] ? { cursor: cursorByServerId[host.serverId]! } : {}),
        });
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const question of payload.questions) {
          questions.push({ ...question, serverId: host.serverId, serverName: host.serverName });
        }
        if (payload.pageInfo) {
          pageInfoByServerId[host.serverId] = payload.pageInfo;
        } else {
          pageInfoByServerId[host.serverId] = { nextCursor: null, hasMore: false };
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (isInitialPage) {
    if (
      connectedAttempts > 0 &&
      questions.length === 0 &&
      hostErrors.length === connectedAttempts
    ) {
      throw new Error(ALL_QUESTION_HOSTS_FAILED_MESSAGE);
    }

    const hasSettlingHost = input.hosts.some((host) =>
      isQuestionHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
    );
    if (questions.length === 0 && hasSettlingHost && hostErrors.length === 0) {
      return { status: "connecting" };
    }
  }

  questions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { status: "loaded", data: questions, hostErrors, pageInfoByServerId };
}

export function getNextQuestionsPageParam(
  page: FetchAggregatedQuestionsResult,
): Record<string, string | null> | null {
  const cursorByServerId: Record<string, string | null> = {};
  for (const [serverId, pageInfo] of Object.entries(page.pageInfoByServerId)) {
    if (pageInfo.hasMore && pageInfo.nextCursor) {
      cursorByServerId[serverId] = pageInfo.nextCursor;
    }
  }
  return Object.keys(cursorByServerId).length > 0 ? cursorByServerId : null;
}
