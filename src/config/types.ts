/**
 * mallm platform configuration — v1.1 keys layered on top of the mallm.yaml resolver chain.
 *
 * A v1.0 mallm.yaml carries none of these keys; every accessor fills defaults so
 * v1.0 files stay valid.
 */

export type SourceKind = "http" | "git" | "dir";

export interface MallmSource {
  name: string;
  kind: SourceKind;
  /** http: URL to fetch; dir: local directory path */
  url?: string;
  /** git: repository URL to clone/fetch (alternative to url) */
  repo?: string;
  /** git: branch to track */
  branch?: string;
  /** lower number = higher precedence when merging sources */
  priority?: number;
  /** reference to a credential holder; never a credential value itself */
  credsRef?: string;
}

export interface InferenceConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}

export interface RedactionConfig {
  /** regex sources (strings) applied by the changelog redactor in addition to built-ins */
  patterns: string[];
}

export interface PlatformConfig {
  version: "1.0" | "1.1";
  sources: MallmSource[];
  inference: InferenceConfig;
  redaction: RedactionConfig;
  /** session TTL in seconds */
  sessionTtl: number;
}

export const SOURCE_KINDS: readonly SourceKind[] = ["http", "git", "dir"];

export const DEFAULT_SOURCE_PRIORITY = 100;

export const DEFAULT_SESSION_TTL_SECONDS = 86_400;
