/**
 * Adapter registry.
 *
 * Detection and listing are isolated per adapter: one broken or unreadable
 * source must never take down the whole hub. Everything is collected with
 * allSettled semantics and surfaced as per-harness status rows.
 */

import type { DetectionResult, ExternalSession, HarnessId } from "../types.ts";
import { HARNESS_ORDER } from "../types.ts";
import type { SessionAdapter } from "./types.ts";
import { PiAdapter } from "./pi.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import { CrushAdapter } from "./crush.ts";
import { JCodeAdapter } from "./jcode.ts";

export class AdapterRegistry {
  private readonly adapters = new Map<HarnessId, SessionAdapter>();
  private readonly enabled = new Set<HarnessId>(HARNESS_ORDER);

  constructor(home: string) {
    for (const adapter of [
      new PiAdapter(home),
      new ClaudeCodeAdapter(home),
      new CodexAdapter(home),
      new OpenCodeAdapter(home),
      new CrushAdapter(home),
      new JCodeAdapter(home),
    ]) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  all(): SessionAdapter[] {
    return HARNESS_ORDER.map((id) => this.adapters.get(id)).filter(
      (a): a is SessionAdapter => Boolean(a),
    );
  }

  active(): SessionAdapter[] {
    return this.all().filter((a) => this.enabled.has(a.id));
  }

  get(id: HarnessId): SessionAdapter | undefined {
    return this.adapters.get(id);
  }

  setEnabled(id: HarnessId, on: boolean): void {
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
  }

  isEnabled(id: HarnessId): boolean {
    return this.enabled.has(id);
  }

  async detectAll(): Promise<DetectionResult[]> {
    const results = await Promise.all(
      this.all().map(async (adapter) => {
        try {
          return await adapter.detect();
        } catch (err) {
          return {
            harness: adapter.id,
            status: "error" as const,
            root: "",
            sessionCount: 0,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return results;
  }

  async listAll(maxPerHarness = 2000): Promise<{
    sessions: ExternalSession[];
    errors: { harness: HarnessId; message: string }[];
  }> {
    const sessions: ExternalSession[] = [];
    const errors: { harness: HarnessId; message: string }[] = [];

    const settled = await Promise.allSettled(
      this.active().map(async (adapter) => {
        const list = await adapter.listSessions({ maxSessions: maxPerHarness });
        return { id: adapter.id, list };
      }),
    );

    for (const result of settled) {
      if (result.status === "fulfilled") {
        sessions.push(...result.value.list);
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ harness: "pi", message });
      }
    }

    sessions.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });

    return { sessions, errors };
  }
}
