/**
 * Strictly pre-write redactor — everything that reaches history.jsonl (or any
 * other consumer) passes through here first. There is no raw-output escape
 * hatch by design. Exported for reuse by other mallm modules and CLIs.
 *
 * All rule fixtures in tests use FAKE values; this module never needs a real
 * secret to be exercised.
 */

export type RedactionRuleId =
  | "pem"
  | "cred-url"
  | "bearer"
  | "env-assign"
  | "config-pattern"
  | "entropy";

export interface RedactResult {
  text: string;
  /** rule ids that fired, in order of first appearance (deduped) */
  applied: RedactionRuleId[];
}

const SECRETISH_NAME = /(token|secret|password|passwd|pass|key|cred|auth|api|private|session)/i;
const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_MIN_BITS_PER_CHAR = 4.5;

/** Shannon entropy in bits per character. */
export function shannonBitsPerChar(input: string): number {
  if (input.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** ≥20 chars, >4.5 bits/char, and looks key-ish (mixed classes or base64-ish punctuation). */
export function isHighEntropyToken(candidate: string): boolean {
  if (candidate.length < ENTROPY_MIN_LENGTH) return false;
  if (shannonBitsPerChar(candidate) <= ENTROPY_MIN_BITS_PER_CHAR) return false;
  const hasLetter = /[a-z]/i.test(candidate);
  const hasDigit = /\d/.test(candidate);
  const hasBase64Punct = /[+/=_~-]/.test(candidate);
  return (hasLetter && hasDigit) || (hasLetter && hasBase64Punct) || (hasDigit && hasBase64Punct);
}

function marker(rule: RedactionRuleId): string {
  return `[REDACTED:${rule}]`;
}

class Tracker {
  readonly applied: RedactionRuleId[] = [];
  track(rule: RedactionRuleId): void {
    if (!this.applied.includes(rule)) this.applied.push(rule);
  }
}

function redactPem(text: string, tracker: Tracker): string {
  const re =
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
  const out = text.replace(re, () => {
    tracker.track("pem");
    return marker("pem");
  });
  return out;
}

function redactCredUrls(text: string, tracker: Tracker): string {
  const re = /(:\/\/)([^/:@\s"']+):([^@\s"']+)(@)/g;
  return text.replace(re, (_m, scheme: string, user: string, _pass: string, at: string) => {
    tracker.track("cred-url");
    return `${scheme}${user}:${marker("cred-url")}${at}`;
  });
}

function redactBearerAndAccessKeys(text: string, tracker: Tracker): string {
  let out = text;
  const rules: Array<[RegExp, string]> = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer "],
    [/\bAKIA[0-9A-Z]{16}\b/g, ""],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, ""],
    [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, ""],
    [/\bsk-[A-Za-z0-9]{16,}\b/g, ""],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, ""],
  ];
  for (const [re, prefix] of rules) {
    out = out.replace(re, (match) => {
      tracker.track("bearer");
      return `${prefix}${marker("bearer")}`;
    });
  }
  return out;
}

function redactEnvAssignments(text: string, tracker: Tracker): string {
  const re = /([A-Za-z_][A-Za-z0-9_]{1,})=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`]+))/g;
  return text.replace(re, (match, name: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    if (value.startsWith("[REDACTED")) return match;
    if (SECRETISH_NAME.test(name) || isHighEntropyToken(value)) {
      tracker.track("env-assign");
      return `${name}=${marker("env-assign")}`;
    }
    return match;
  });
}

function redactConfigPatterns(text: string, patterns: string[], tracker: Tracker): string {
  let out = text;
  for (const source of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(source, "g");
    } catch {
      continue; // invalid pattern in config: skipped, never fatal
    }
    out = out.replace(re, () => {
      tracker.track("config-pattern");
      return marker("config-pattern");
    });
  }
  return out;
}

function redactEntropy(text: string, tracker: Tracker): string {
  return text
    .split(/(\s+)/)
    .map((chunk) => {
      if (/^\s*$/.test(chunk)) return chunk;
      const stripped = chunk.replace(/^[("'`,;:[\]{}]+|[)"'`,;:[\]{}]+$/g, "");
      // never fire on our own redaction markers
      if (stripped.startsWith("[REDACTED") || chunk.includes("[REDACTED:")) {
        return chunk;
      }
      if (!isHighEntropyToken(stripped)) return chunk;
      tracker.track("entropy");
      return chunk.split(stripped).join(marker("entropy"));
    })
    .join("");
}

/**
 * Apply every redaction rule. `extraPatternSources` are regex *source strings*
 * (typically from `config.redaction.patterns`), applied after the built-ins.
 */
export function redact(input: string, extraPatternSources: readonly string[] = []): RedactResult {
  const tracker = new Tracker();
  let text = input;
  text = redactPem(text, tracker);
  text = redactCredUrls(text, tracker);
  text = redactBearerAndAccessKeys(text, tracker);
  text = redactEnvAssignments(text, tracker);
  text = redactConfigPatterns(text, extraPatternSources, tracker);
  text = redactEntropy(text, tracker);
  return { text, applied: tracker.applied };
}
