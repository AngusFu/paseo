import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { parseQuestionFormQuestions, type QuestionFormQuestion } from "./question-form-card-core";

type AskQuestionStatus = "executing" | "running" | "completed" | "failed" | "canceled";

interface AskQuestionCardProps {
  questions: QuestionFormQuestion[];
  result?: unknown;
  error?: unknown;
  status: AskQuestionStatus;
  disableOuterSpacing?: boolean;
  testID?: string;
}

export function parseAskQuestionArgs(args: unknown): QuestionFormQuestion[] | null {
  if (typeof args === "string") {
    try {
      return parseQuestionFormQuestions(JSON.parse(args));
    } catch {
      return null;
    }
  }
  return parseQuestionFormQuestions(args);
}

function extractOutput(result: unknown): unknown {
  if (result && typeof result === "object" && "output" in result) {
    return (result as { output: unknown }).output;
  }
  return result;
}

function parseAnswerPairs(output: unknown): Record<string, string> | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // not JSON — fall through to "question"="answer" pair parsing
    }
    const pairs: Record<string, string> = {};
    const pairPattern = /"([^"]+)"\s*=\s*"([^"]*)"/g;
    let match = pairPattern.exec(output);
    while (match) {
      pairs[match[1]] = match[2];
      match = pairPattern.exec(output);
    }
    return Object.keys(pairs).length > 0 ? pairs : null;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, string>;
  }
  return null;
}

function formatRawOutput(output: unknown): string {
  if (output == null) {
    return "";
  }
  return typeof output === "string" ? output : JSON.stringify(output);
}

function extractErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.content === "string") {
      return record.content;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return "";
}

// The Claude Agent SDK reports a denied AskUserQuestion as a failed tool_result
// whose content is its own canned rejection text ("doesn't want to proceed" /
// "want to proceed"), or the literal message Paseo's own Dismiss button sends
// ("Dismissed by user") — neither is a genuine tool-call failure.
const DISMISSED_ERROR_PATTERN = /want to proceed|dismiss(ed)? by user/i;

function isDismissed(status: AskQuestionStatus, error: unknown): boolean {
  if (status === "canceled") {
    return true;
  }
  return status === "failed" && DISMISSED_ERROR_PATTERN.test(extractErrorText(error));
}

export const AskQuestionCard = memo(function AskQuestionCard({
  questions,
  result,
  error,
  status,
  disableOuterSpacing,
  testID,
}: AskQuestionCardProps) {
  const { t } = useTranslation();
  const containerStyle = useMemo(
    () => [styles.container, disableOuterSpacing && styles.containerCompact],
    [disableOuterSpacing],
  );

  if (status === "failed" || status === "canceled") {
    const headerText = isDismissed(status, error)
      ? `⊘ ${t("message.question.notAnswered")}`
      : `⚠ ${t("message.question.callFailed")}`;
    return (
      <View testID={testID} style={containerStyle}>
        <Text style={styles.headerTextDanger}>{headerText}</Text>
        {questions.map((question) => (
          <Text key={question.question} style={styles.questionText}>
            {question.question}
          </Text>
        ))}
      </View>
    );
  }

  if (status === "running" || status === "executing") {
    return (
      <View testID={testID} style={containerStyle}>
        <Text
          style={styles.headerTextWaiting}
        >{`⏳ ${t("message.question.waitingForAnswer")}`}</Text>
        {questions.map((question) => (
          <View key={question.question} style={styles.questionBlock}>
            <Text style={styles.questionText}>
              {question.question}
              {question.multiSelect ? ` (${t("message.question.multiSelect")})` : ""}
            </Text>
            {question.options.map((option) => (
              <View key={option.label} style={styles.optionRow}>
                <Text style={styles.optionLabel}>{`○ ${option.label}`}</Text>
                {option.description ? (
                  <Text style={styles.optionDescription}>{option.description}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }

  const answers = parseAnswerPairs(extractOutput(result));
  if (!answers) {
    return (
      <View testID={testID} style={containerStyle}>
        {questions.map((question) => (
          <Text key={question.question} style={styles.questionText}>
            {question.question}
          </Text>
        ))}
        <Text style={styles.rawOutput}>{formatRawOutput(extractOutput(result))}</Text>
      </View>
    );
  }

  return (
    <View testID={testID} style={containerStyle}>
      {questions.map((question) => (
        <View key={question.question} style={styles.questionBlock}>
          <Text style={styles.questionText}>{question.question}</Text>
          <Text style={styles.answerText}>
            {`→ ${answers[question.question] ?? answers[question.header] ?? "—"}`}
          </Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  headerTextWaiting: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusWarning,
  },
  headerTextDanger: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusDanger,
  },
  questionBlock: {
    gap: theme.spacing[1],
  },
  questionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  answerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusSuccess,
    lineHeight: 20,
  },
  optionRow: {
    paddingLeft: theme.spacing[3],
    gap: theme.spacing[1],
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  optionDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
  rawOutput: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
