/**
 * Wire types for TypeSafe AI's System One endpoint (POST /v1/systemone).
 *
 * These mirror https://docs.typesafe.ai/api and are duplicated here (rather than
 * imported from `@typesafe-ai/sdk`) because the same code runs in the browser,
 * where node_modules are not available. They are structurally compatible with
 * the SDK's own types, so the server can hand SDK results straight back.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** `instructions` and `criteria` entries accept text or JSON structure. */
export type EntryType = JsonValue;

export interface NoulQuestion {
  type: 'noul';
  instructions: EntryType;
  criteria?: { true?: EntryType; false?: EntryType };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: EntryType;
  /** option label -> rubric description (null when the label speaks for itself) */
  criteria: Record<string, EntryType>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: EntryType;
  /** ordered level descriptions, lowest first; at least two */
  criteria: EntryType[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** 0 = no, 1 = yes */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, EntryType>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  state: EntryType;
  model: string;
  questions: Record<string, Question>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

/** $0.042 per million input tokens; output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function estimateCostUsd(usage: Usage): number {
  return usage.input_tokens * USD_PER_INPUT_TOKEN;
}
