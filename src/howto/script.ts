import type { EnvironmentProbe } from "../env/index.js";
import type { InstallPlanItem } from "./types.js";

/**
 * Heuristic script → command-name extraction, used by GATE_INSTALL to decide
 * which tools a candidate needs. Deliberately conservative: shell builtins and
 * control keywords are skipped; only the FIRST command of a pipeline/line is
 * collected (if its tools exist, the script can start; the run gate reveals
 * anything the heuristic missed).
 */

export const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  "echo", "cd", "printf", "test", "[", "[[", "export", "local", "readonly",
  "read", "shift", "true", "false", "source", ".", "alias", "unalias", "set",
  "unset", "umask", "pushd", "popd", "dirs", "trap", "wait", "jobs", "fg",
  "bg", "return", "eval", "exec", "getopts", "hash", "type", "command",
  "pwd", "let", "declare", "shopt", "bind", "builtin", "caller", "times",
]);

export const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "{", "}", "!", "time", "select",
  "coproc", "&", "|", ";", "&&", "||",
]);

const ASSIGN_PREFIX =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/;

/** Command names invoked by the script (deduped, order of first appearance). */
export function scriptCommands(script: string): string[] {
  const seen: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("set ") || line === "set" || line.startsWith("set	")) continue;
    let cmd = line;
    // strip leading VAR=... assignments (possibly several): FOO=1 BAR=2 baz → baz
    while (ASSIGN_PREFIX.test(cmd)) cmd = cmd.replace(ASSIGN_PREFIX, "");
    if (cmd === "") continue;
    let word = cmd.split(/[;&|()\s]+/, 1)[0] ?? "";
    word = word.replace(/['"]/g, "").replace(/^\$+/, "");
    if (word === "" || word.startsWith("-") || word.startsWith("\\")) continue;
    if (CONTROL_KEYWORDS.has(word) || SHELL_BUILTINS.has(word)) continue;
    if (!/^[A-Za-z0-9._@%+-]+$/.test(word)) continue;
    if (!seen.includes(word)) seen.push(word);
  }
  return seen;
}

/** Commands the script needs that the probe did not find on PATH. */
export function missingTools(script: string, probe: EnvironmentProbe): string[] {
  const present = new Set(probe.tools.map((t) => t.name));
  return scriptCommands(script).filter((cmd) => !present.has(cmd));
}

/** Installer arg templates; anything else falls back to `<installer> install <tool>`. */
const INSTALLER_ARGS: Record<string, (tool: string) => string[]> = {
  brew: (t) => ["install", t],
  apt: (t) => ["install", "-y", t],
  "apt-get": (t) => ["install", "-y", t],
  npm: (t) => ["install", "-g", t],
  pip3: (t) => ["install", t],
  cargo: (t) => ["install", t],
};

/**
 * Split missing tools into an installable plan (first available installer
 * wins) and tools no known installer can provide (surfaced in the run-gate
 * approval payload so the approver knows the environment may not satisfy them).
 */
export function planInstalls(
  missing: readonly string[],
  probe: EnvironmentProbe
): { plan: InstallPlanItem[]; uninstallable: string[] } {
  const plan: InstallPlanItem[] = [];
  const uninstallable: string[] = [];
  const installers = probe.installers;
  for (const tool of missing) {
    const installer =
      installers.find((i) => INSTALLER_ARGS[i] !== undefined) ??
      installers.find((i) => i !== "winget" && i !== "choco" && i !== "scoop");
    if (!installer) {
      uninstallable.push(tool);
      continue;
    }
    plan.push({
      tool,
      installer,
      args: INSTALLER_ARGS[installer]?.(tool) ?? ["install", tool],
    });
  }
  return { plan, uninstallable };
}
