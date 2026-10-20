import type { KnowledgeTopic } from "../memory/index.js";
import type { JevAnswer, JevQuestion } from "./client.js";

/**
 * Quiz round construction + plain-text rendering + answer application.
 * Questions are built from knowledge.yaml topics, LOWEST confidence first —
 * the weakest knowledge is what the platform most needs to probe.
 */

export interface QuizRound {
  questions: JevQuestion[];
  /** question id → correct option (choice questions only) */
  expected: Record<string, string>;
}

export interface AnswerDelta {
  topicId: string;
  from: number;
  to: number;
}

export const QUIZ_NOTE =
  "plain-text quiz rendering for now — SemText view-as=quiz rendering lands in wave 2b";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function buildQuiz(
  topics: readonly KnowledgeTopic[],
  opts: {
    limit?: number;
    topicId?: string;
    /** topic id/name → corpus usage synopsis (enables the choice question) */
    synopses?: Record<string, string>;
  } = {}
): QuizRound {
  const limit = opts.limit ?? 5;
  const ordered = [...topics]
    .filter((t) => !opts.topicId || t.id === opts.topicId)
    .sort((a, b) => a.confidence - b.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(1, limit));

  const questions: JevQuestion[] = [];
  const expected: Record<string, string> = {};
  for (const topic of ordered) {
    questions.push({
      id: `${topic.id}:b`,
      topicId: topic.id,
      type: "boolean",
      prompt: `Can you write a working how-to for '${topic.name}' without checking docs first?`,
    });
    questions.push({
      id: `${topic.id}:s`,
      topicId: topic.id,
      type: "score",
      prompt: `Rate your confidence using '${topic.name}'.`,
      scale: { min: 0, max: 10 },
    });
    const synopsis = opts.synopses?.[topic.id];
    if (synopsis) {
      const distractors = ["--help", `man ${topic.id}`];
      const options = [synopsis, ...distractors];
      questions.push({
        id: `${topic.id}:c`,
        topicId: topic.id,
        type: "choice",
        prompt: `Which usage synopsis matches '${topic.name}'?`,
        options,
      });
      expected[`${topic.id}:c`] = synopsis;
    }
  }
  return { questions, expected };
}

export function renderQuizPlain(round: QuizRound): string {
  const lines: string[] = [`# mallm quiz (${round.questions.length} questions)`, QUIZ_NOTE, ""];
  round.questions.forEach((q, i) => {
    const label = `${i + 1}. [${q.type}] ${q.topicId}`;
    lines.push(`${label} — ${q.prompt}`);
    if (q.options) {
      q.options.forEach((opt, j) => lines.push(`   ${LETTERS[j] ?? j}) ${opt}`));
    }
    if (q.scale) {
      lines.push(`   (answer with a number ${q.scale.min}-${q.scale.max})`);
    }
    if (q.type === "boolean") {
      lines.push("   (answer yes/no)");
    }
  });
  lines.push("");
  lines.push("Answer with: mallm learn (jev round) or apply answers manually via knowledge.yaml");
  return lines.join("\n");
}

function clampConfidence(n: number): number {
  return Math.min(10, Math.max(0, Math.round(n)));
}

/**
 * Apply answers to topics:
 * - boolean: yes +2 / no -2
 * - score:   sets confidence to the rated value (0-10)
 * - choice:  correct +1 / wrong -1 (questions without an expected option are ignored)
 * lastSeen refreshes on every applied answer. Returns new topics + deltas.
 */
export function applyQuizAnswers(
  topics: readonly KnowledgeTopic[],
  questions: readonly JevQuestion[],
  answers: readonly JevAnswer[],
  expected: Record<string, string> = {},
  nowIso: string = new Date().toISOString()
): { topics: KnowledgeTopic[]; deltas: AnswerDelta[] } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const next = topics.map((t) => ({ ...t }));
  const deltas: AnswerDelta[] = [];

  for (const answer of answers) {
    const question = byId.get(answer.id);
    if (!question) continue;
    const topic = next.find((t) => t.id === question.topicId);
    if (!topic) continue;

    let confidence: number | undefined;
    if (question.type === "boolean" && typeof answer.answer === "boolean") {
      confidence = topic.confidence + (answer.answer ? 2 : -2);
    } else if (question.type === "score" && typeof answer.answer === "number" && Number.isFinite(answer.answer)) {
      confidence = answer.answer;
    } else if (question.type === "choice" && typeof answer.answer === "string") {
      const want = expected[answer.id];
      if (want === undefined) continue;
      confidence = topic.confidence + (answer.answer === want ? 1 : -1);
    }
    if (confidence === undefined) continue;

    const to = clampConfidence(confidence);
    if (to !== topic.confidence) {
      deltas.push({ topicId: topic.id, from: topic.confidence, to });
    }
    topic.confidence = to;
    topic.lastSeen = nowIso;
  }
  return { topics: next, deltas };
}
