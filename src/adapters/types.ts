import type {
  DetectionResult,
  ExternalSession,
  HarnessId,
  SessionDetail,
} from "../types.ts";

export interface ListOptions {
  /** Hard cap on sessions returned by a single adapter. */
  maxSessions?: number;
}

/**
 * Every harness gets one adapter. Adapters are strictly read-only: they open
 * files and SQLite databases for reading and never write outside the
 * extension's own index directory.
 */
export interface SessionAdapter {
  id: HarnessId;
  displayName: string;

  /** Cheap probe: does the store exist, is it readable, how many sessions. */
  detect(): Promise<DetectionResult>;

  /** Metadata-only listing. Must not load full transcripts. */
  listSessions(opts?: ListOptions): Promise<ExternalSession[]>;

  /** Full transcript for one session, used by preview and handoff. */
  getSession(nativeId: string): Promise<SessionDetail | null>;

  /**
   * Native resume command for the original harness, or null when no safe,
   * verified command exists. Never guesses.
   */
  buildNativeResume(nativeId: string): Promise<NativeResumeAction | null>;
}

export interface NativeResumeAction {
  command: string;
  args: string[];
  cwd?: string;
  /**
   * How we know this command line is real. The hub never offers a command it
   * cannot justify, and it says which justification it used.
   *  - "cli-help": the flag is documented in the harness's own `--help`
   *  - "executed": the command was actually run successfully during development
   */
  verificationBasis: "cli-help" | "executed";
  /** True only when the basis is strong enough to offer the action. */
  verified: boolean;
  /** Human-readable explanation of the evidence, shown before confirmation. */
  verificationNote: string;
  /** Always true: the hub never spawns a process without explicit consent. */
  requiresConfirmation: true;
  /** Human-readable explanation shown before confirmation. */
  description: string;
}
