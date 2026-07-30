import type { AgentModelDefinition, AgentProvider, AgentSelectOption } from "../agent-sdk-types.js";

/**
 * Cursor CLI encodes effort + fast into the model id:
 *   cursor-grok-4.5-high-fast → base=cursor-grok-4.5, effort=high, fast=true
 *   composer-2.5-fast         → base=composer-2.5, effort=null (bare), fast=true
 *   gpt-5.5-extra-high        → base=gpt-5.5, effort=extra-high, fast=false
 *
 * Paseo catalog shows the base model; thinkingOptionId + featureValues.fast_mode
 * select the variant. The CLI still receives the concrete wire id.
 */

/** Bare (no effort suffix) variant — matches app resolveThinkingId "default" handling. */
export const CURSOR_PRINT_BARE_EFFORT_ID = "default";

export const CURSOR_PRINT_FAST_MODE_FEATURE_ID = "fast_mode";

/** Longest-first so `extra-high` wins over `high`. */
const EFFORT_SUFFIXES = [
  "extra-high",
  "minimal",
  "medium",
  "xhigh",
  "none",
  "high",
  "low",
  "max",
] as const;

export type CursorPrintEffortId =
  | (typeof EFFORT_SUFFIXES)[number]
  | typeof CURSOR_PRINT_BARE_EFFORT_ID;

const EFFORT_SORT_ORDER: Record<string, number> = {
  [CURSOR_PRINT_BARE_EFFORT_ID]: 0,
  none: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  "extra-high": 6,
  max: 7,
};

const EFFORT_LABELS: Record<string, string> = {
  [CURSOR_PRINT_BARE_EFFORT_ID]: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  "extra-high": "Extra High",
  max: "Max",
};

export interface CursorPrintModelParts {
  /** Catalog / config model id (suffixes stripped). */
  baseId: string;
  /** Effort token, or bare sentinel when the wire id has no effort suffix. */
  effortId: CursorPrintEffortId;
  fast: boolean;
  /** Original Cursor CLI model id. */
  wireId: string;
}

export interface CursorPrintRawModel {
  id: string;
  label: string;
  isDefault?: boolean;
}

function stripFastSuffix(id: string): { id: string; fast: boolean } {
  if (id.endsWith("-fast")) {
    return { id: id.slice(0, -"-fast".length), fast: true };
  }
  return { id, fast: false };
}

function stripEffortSuffix(id: string): { baseId: string; effortId: CursorPrintEffortId } {
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { baseId: id.slice(0, -suffix.length), effortId: effort };
    }
  }
  return { baseId: id, effortId: CURSOR_PRINT_BARE_EFFORT_ID };
}

/**
 * Cursor CLI `--model` accepts slug wire ids (`cursor-grok-4.5-high-fast`).
 * `system/init` reports human display labels (`Cursor Grok 4.5 High Fast`) —
 * those must never be passed back as `--model`.
 */
export function isCursorPrintWireModelId(modelId: string | null | undefined): boolean {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  return id.length > 0 && !/\s/.test(id);
}

/**
 * Parse a Cursor CLI model id into base + effort + fast.
 * Display labels and empty ids return null.
 */
export function parseCursorPrintModelId(
  modelId: string | null | undefined,
): CursorPrintModelParts | null {
  const wireId = typeof modelId === "string" ? modelId.trim() : "";
  if (!isCursorPrintWireModelId(wireId)) {
    return null;
  }
  const { id: withoutFast, fast } = stripFastSuffix(wireId);
  if (!withoutFast) {
    return null;
  }
  const { baseId, effortId } = stripEffortSuffix(withoutFast);
  if (!baseId) {
    return null;
  }
  return { baseId, effortId, fast, wireId };
}

const DISPLAY_EFFORT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  effortId: CursorPrintEffortId;
}> = [
  { pattern: /\s+Extra\s+High$/i, effortId: "extra-high" },
  { pattern: /\s+Minimal$/i, effortId: "minimal" },
  { pattern: /\s+Medium$/i, effortId: "medium" },
  { pattern: /\s+None$/i, effortId: "none" },
  { pattern: /\s+High$/i, effortId: "high" },
  { pattern: /\s+Low$/i, effortId: "low" },
  { pattern: /\s+Max$/i, effortId: "max" },
];

/**
 * Parse a Cursor display label from system/init into base hint + effort + fast.
 * Returns null for wire ids / empty strings.
 */
export function parseCursorPrintDisplayLabel(label: string | null | undefined): {
  baseHint: string;
  effortId: CursorPrintEffortId;
  fast: boolean;
} | null {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed || isCursorPrintWireModelId(trimmed)) {
    return null;
  }
  let rest = trimmed;
  let fast = false;
  if (/\s+Fast$/i.test(rest)) {
    fast = true;
    rest = rest.replace(/\s+Fast$/i, "").trim();
  }
  let effortId: CursorPrintEffortId = CURSOR_PRINT_BARE_EFFORT_ID;
  for (const { pattern, effortId: effort } of DISPLAY_EFFORT_PATTERNS) {
    if (pattern.test(rest)) {
      effortId = effort;
      rest = rest.replace(pattern, "").trim();
      break;
    }
  }
  if (!rest) {
    return null;
  }
  return { baseHint: rest, effortId, fast };
}

/**
 * Recover catalog base + effort + fast from a Cursor display label.
 * Used when persistence / runtime state was corrupted by system/init labels.
 */
export function matchCursorPrintCatalogFromDisplayLabel(
  label: string | null | undefined,
  catalog: readonly AgentModelDefinition[],
): { baseId: string; effortId: CursorPrintEffortId; fast: boolean } | null {
  const parsed = parseCursorPrintDisplayLabel(label);
  if (!parsed || catalog.length === 0) {
    return null;
  }
  const hint = parsed.baseHint.toLowerCase();
  const byExact = catalog.find((model) => model.label.trim().toLowerCase() === hint);
  const byPrefix =
    byExact ??
    catalog.find((model) => {
      const modelLabel = model.label.trim().toLowerCase();
      return hint.startsWith(modelLabel) || modelLabel.startsWith(hint);
    });
  if (!byPrefix) {
    return null;
  }

  const thinkingIds = new Set(byPrefix.thinkingOptions?.map((option) => option.id) ?? []);
  let effortId = parsed.effortId;
  if (effortId === CURSOR_PRINT_BARE_EFFORT_ID) {
    effortId =
      (byPrefix.defaultThinkingOptionId as CursorPrintEffortId | undefined) ??
      CURSOR_PRINT_BARE_EFFORT_ID;
  } else if (thinkingIds.size > 0 && !thinkingIds.has(effortId)) {
    effortId =
      (byPrefix.defaultThinkingOptionId as CursorPrintEffortId | undefined) ??
      CURSOR_PRINT_BARE_EFFORT_ID;
  }

  return { baseId: byPrefix.id, effortId, fast: parsed.fast };
}

/**
 * Compose the concrete Cursor CLI `--model` id from catalog base + effort + fast.
 */
export function composeCursorPrintWireModel(options: {
  baseId: string;
  effortId?: string | null;
  fast?: boolean;
}): string {
  const baseId = options.baseId.trim();
  if (!baseId) {
    return baseId;
  }
  const effort =
    typeof options.effortId === "string" && options.effortId.trim().length > 0
      ? options.effortId.trim()
      : CURSOR_PRINT_BARE_EFFORT_ID;
  const withEffort =
    effort === CURSOR_PRINT_BARE_EFFORT_ID || effort === "default" ? baseId : `${baseId}-${effort}`;
  return options.fast ? `${withEffort}-fast` : withEffort;
}

function stripVariantWordsFromLabel(label: string): string {
  return label
    .replace(/\s+Fast$/i, "")
    .replace(/\s+Extra\s+High$/i, "")
    .replace(/\s+Minimal$/i, "")
    .replace(/\s+Medium$/i, "")
    .replace(/\s+None$/i, "")
    .replace(/\s+High$/i, "")
    .replace(/\s+Low$/i, "")
    .replace(/\s+Max$/i, "")
    .trim();
}

/** True when the Cursor label already names an effort/fast tier. */
function labelNamesExplicitVariant(label: string): boolean {
  return /\s+(?:None|Minimal|Low|Medium|High|Extra\s+High|Max|Fast)$/i.test(label.trim());
}

function effortSortKey(effortId: string): number {
  return EFFORT_SORT_ORDER[effortId] ?? 50;
}

function pickDefaultEffortId(
  efforts: Set<string>,
  preferredEffortId: string | null,
  unmarkedEffortIds: Set<string>,
): string | undefined {
  if (preferredEffortId && efforts.has(preferredEffortId)) {
    return preferredEffortId;
  }
  if (efforts.has(CURSOR_PRINT_BARE_EFFORT_ID)) {
    return CURSOR_PRINT_BARE_EFFORT_ID;
  }
  // Cursor's product default is usually the tier whose label omits Low/High/…
  // (e.g. "Cursor Grok 4.5" for high, "GPT-5.6 Sol 1M" for medium).
  const unmarked = [...unmarkedEffortIds]
    .filter((effort) => efforts.has(effort))
    .sort((a, b) => effortSortKey(a) - effortSortKey(b));
  if (unmarked[0]) {
    return unmarked[0];
  }
  if (efforts.has("medium")) {
    return "medium";
  }
  if (efforts.has("high")) {
    return "high";
  }
  return [...efforts].sort((a, b) => effortSortKey(a) - effortSortKey(b))[0];
}

interface GroupAccumulator {
  baseId: string;
  labels: string[];
  efforts: Set<string>;
  supportsFast: boolean;
  /** effortId → preferred display label (non-fast preferred). */
  effortLabels: Map<string, string>;
  isDefault: boolean;
  preferredEffortId: string | null;
  /** Efforts whose non-fast label does not name a tier (Cursor's product default). */
  unmarkedEffortIds: Set<string>;
  /** Known wire ids for fallback when an exact compose misses the catalog. */
  wireIds: Set<string>;
}

/**
 * Collapse Cursor CLI model rows (effort/fast variants) into catalog base models
 * with thinkingOptions + fast support metadata.
 */
export function groupCursorPrintModels(
  rawModels: CursorPrintRawModel[],
  provider: AgentProvider,
): AgentModelDefinition[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const raw of rawModels) {
    const parsed = parseCursorPrintModelId(raw.id);
    if (!parsed) {
      continue;
    }
    let group = groups.get(parsed.baseId);
    if (!group) {
      group = {
        baseId: parsed.baseId,
        labels: [],
        efforts: new Set(),
        supportsFast: false,
        effortLabels: new Map(),
        isDefault: false,
        preferredEffortId: null,
        unmarkedEffortIds: new Set(),
        wireIds: new Set(),
      };
      groups.set(parsed.baseId, group);
    }
    group.wireIds.add(parsed.wireId);
    group.efforts.add(parsed.effortId);
    if (parsed.fast) {
      group.supportsFast = true;
    } else if (!labelNamesExplicitVariant(raw.label)) {
      group.unmarkedEffortIds.add(parsed.effortId);
    }
    const cleanedLabel = stripVariantWordsFromLabel(raw.label) || parsed.baseId;
    group.labels.push(cleanedLabel);
    if (!parsed.fast || !group.effortLabels.has(parsed.effortId)) {
      group.effortLabels.set(parsed.effortId, EFFORT_LABELS[parsed.effortId] ?? parsed.effortId);
    }
    if (raw.isDefault) {
      group.isDefault = true;
      group.preferredEffortId = parsed.effortId;
    }
  }

  const models: AgentModelDefinition[] = [];
  for (const group of groups.values()) {
    const defaultEffortId = pickDefaultEffortId(
      group.efforts,
      group.preferredEffortId,
      group.unmarkedEffortIds,
    );
    const hasExplicitEfforts = [...group.efforts].some(
      (effort) => effort !== CURSOR_PRINT_BARE_EFFORT_ID,
    );
    // Only expose thinking when the CLI actually offers effort-encoded variants.
    const thinkingOptions: AgentSelectOption[] | undefined = hasExplicitEfforts
      ? [...group.efforts]
          .sort((a, b) => effortSortKey(a) - effortSortKey(b))
          .map((effortId) => ({
            id: effortId,
            label: group.effortLabels.get(effortId) ?? EFFORT_LABELS[effortId] ?? effortId,
            isDefault: effortId === defaultEffortId,
          }))
      : undefined;

    const label =
      group.labels.sort((a, b) => a.length - b.length)[0] ??
      stripVariantWordsFromLabel(group.baseId) ??
      group.baseId;

    models.push({
      provider,
      id: group.baseId,
      label,
      isDefault: group.isDefault,
      thinkingOptions,
      defaultThinkingOptionId: thinkingOptions
        ? (defaultEffortId ?? thinkingOptions[0]?.id)
        : undefined,
      metadata: {
        cursorPrintSupportsFast: group.supportsFast,
        cursorPrintWireIds: [...group.wireIds].sort(),
      },
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
}

export function cursorPrintModelSupportsFast(
  model: Pick<AgentModelDefinition, "metadata"> | null | undefined,
): boolean {
  return model?.metadata?.cursorPrintSupportsFast === true;
}

function readWireIdAllowList(model: AgentModelDefinition | null | undefined): string[] | null {
  const wireIds = model?.metadata?.cursorPrintWireIds;
  if (!Array.isArray(wireIds) || !wireIds.every((id): id is string => typeof id === "string")) {
    return null;
  }
  return wireIds;
}

function pickAllowedWireId(candidates: string[], allowList: string[] | null): string | null {
  for (const candidate of candidates) {
    if (!allowList || allowList.includes(candidate)) {
      return candidate;
    }
  }
  return allowList?.[0] ?? candidates[0] ?? null;
}

function isLegacyWireModelId(
  parsed: CursorPrintModelParts | null,
  modelId: string,
): parsed is CursorPrintModelParts {
  return Boolean(
    parsed &&
    parsed.wireId === modelId &&
    (parsed.effortId !== CURSOR_PRINT_BARE_EFFORT_ID || parsed.fast),
  );
}

function resolveEffortIdForWireModel(options: {
  thinkingOptionId?: string | null;
  model?: AgentModelDefinition | null;
  parsed: CursorPrintModelParts | null;
  modelId: string;
}): string {
  if (typeof options.thinkingOptionId === "string" && options.thinkingOptionId.trim().length > 0) {
    return options.thinkingOptionId.trim();
  }
  if (options.model?.defaultThinkingOptionId) {
    return options.model.defaultThinkingOptionId;
  }
  if (options.parsed && options.parsed.wireId === options.modelId) {
    return options.parsed.effortId;
  }
  return CURSOR_PRINT_BARE_EFFORT_ID;
}

function resolveFastForWireModel(options: {
  fast?: boolean;
  parsed: CursorPrintModelParts | null;
  modelId: string;
}): boolean {
  if (typeof options.fast === "boolean") {
    return options.fast;
  }
  if (options.parsed && options.parsed.wireId === options.modelId) {
    return options.parsed.fast;
  }
  return false;
}

/**
 * Resolve the concrete CLI `--model` id for a turn.
 *
 * `modelId` may be a catalog base id or a legacy full wire id. When thinking/fast
 * are provided they win; otherwise legacy wire ids pass through unchanged.
 */
export function resolveCursorPrintWireModel(options: {
  modelId: string | null | undefined;
  thinkingOptionId?: string | null;
  fast?: boolean;
  /** Optional catalog entry for the base model (wire id allow-list). */
  model?: AgentModelDefinition | null;
}): string | null {
  const modelId = typeof options.modelId === "string" ? options.modelId.trim() : "";
  if (!modelId) {
    return null;
  }
  // Never pass a display label through to `agent --model`.
  if (!isCursorPrintWireModelId(modelId)) {
    return null;
  }

  const parsed = parseCursorPrintModelId(modelId);
  const baseId = parsed?.baseId ?? modelId;
  const hasExplicitThinking =
    typeof options.thinkingOptionId === "string" && options.thinkingOptionId.trim().length > 0;
  const hasExplicitFast = typeof options.fast === "boolean";

  // Legacy wire id with no explicit effort/fast overrides — keep the concrete id.
  if (isLegacyWireModelId(parsed, modelId) && !hasExplicitThinking && !hasExplicitFast) {
    return modelId;
  }

  const effortId = resolveEffortIdForWireModel({
    thinkingOptionId: options.thinkingOptionId,
    model: options.model,
    parsed,
    modelId,
  });
  const fast = resolveFastForWireModel({
    fast: options.fast,
    parsed,
    modelId,
  });

  const composed = composeCursorPrintWireModel({ baseId, effortId, fast });
  const allowList = readWireIdAllowList(options.model);
  const withoutFast = composeCursorPrintWireModel({ baseId, effortId, fast: false });
  const defaultEffort = options.model?.defaultThinkingOptionId ?? CURSOR_PRINT_BARE_EFFORT_ID;
  const defaultWire = composeCursorPrintWireModel({
    baseId,
    effortId: defaultEffort,
    fast: false,
  });

  return pickAllowedWireId([composed, withoutFast, defaultWire, baseId], allowList);
}

/** Normalize a possibly-wire config model id down to the catalog base id. */
export function normalizeCursorPrintBaseModelId(modelId: string | null | undefined): string | null {
  const parsed = parseCursorPrintModelId(modelId);
  if (parsed) {
    return parsed.baseId;
  }
  // Display labels are not catalog ids — callers must recover via catalog match.
  if (!isCursorPrintWireModelId(modelId)) {
    return null;
  }
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
