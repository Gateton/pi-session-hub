/**
 * Native resume.
 *
 * Two modes, both explicit:
 *  - resolve: return the exact command for the originating harness, if verified.
 *  - launch: spawn it detached, only after the user confirms.
 *
 * A harness with no verified resume-by-id command returns null. The hub never
 * guesses a command line, and never launches anything without consent.
 */

import { spawn } from "node:child_process";
import type { SessionAdapter } from "./adapters/types.ts";
import type { NativeResumeAction } from "./adapters/types.ts";

export type { NativeResumeAction };

export async function resolveNativeResume(
  adapter: SessionAdapter,
  nativeId: string,
): Promise<NativeResumeAction | null> {
  try {
    return await adapter.buildNativeResume(nativeId);
  } catch {
    return null;
  }
}

export function formatNativeResume(action: NativeResumeAction): string {
  const cwd = action.cwd ? ` (cwd: ${action.cwd})` : "";
  return `${action.command} ${action.args.join(" ")}${cwd}`;
}

/** Multi-line block shown in the confirmation dialog. */
export function describeNativeResume(action: NativeResumeAction): string {
  return [
    action.description,
    "",
    `  ${formatNativeResume(action)}`,
    "",
    `Verification: ${action.verificationBasis} \u2014 ${action.verificationNote}`,
    "",
    "This starts a separate process. Your Pi session is not modified.",
  ].join("\n");
}

export interface LaunchResult {
  ok: boolean;
  message: string;
}

/**
 * Spawn the native harness in its own detached process so the user's current Pi
 * session is not blocked. Only called after explicit confirmation.
 */
export function launchNativeResume(action: NativeResumeAction): LaunchResult {
  if (!action.verified) {
    return { ok: false, message: "refusing to launch an unverified command" };
  }
  try {
    const child = spawn(action.command, action.args, {
      cwd: action.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      ok: true,
      message: `launched: ${formatNativeResume(action)}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
