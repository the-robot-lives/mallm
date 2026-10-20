export type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  CandidateSource,
  DiagnoseResult,
  DraftContext,
  HowtoCandidate,
  HowtoDeps,
  HowtoInput,
  HowtoOutcome,
  HowtoRunRecord,
  HowtoRunState,
  HowtoSection,
  HowtoStage,
  HowtoStatus,
  HowtoStepResult,
  InstallPlanItem,
  InstallResult,
  IntakeSnapshot,
  RunOutcome,
  StageEvent,
  WritebackResult,
} from "./types.js";
export { HOWTO_STAGES, MAX_RUN_ATTEMPTS } from "./types.js";
export {
  installApprovalId,
  loadHowtoState,
  advanceHowto,
  newState,
  runApprovalId,
  saveHowtoState,
} from "./machine.js";
export {
  corpusCandidates,
  generateCandidates,
  llmCandidates,
  llmDiagnose,
  parseFencedBash,
  rotateCandidate,
  templateCandidates,
} from "./drafts.js";
export {
  CONTROL_KEYWORDS,
  SHELL_BUILTINS,
  missingTools,
  planInstalls,
  scriptCommands,
} from "./script.js";
export type { DocTarget, RunCommand, WritebackOpts } from "./writeback.js";
export {
  DEFAULT_GH_BIN,
  appendSection,
  defaultRunCommand,
  findDocFile,
  renderSectionEntry,
  writableSource,
  writebackHowto,
} from "./writeback.js";
