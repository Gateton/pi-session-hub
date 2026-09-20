/**
 * Smoke test: exercise every adapter against the real stores on this machine.
 * Run: node test/smoke.mjs
 */

import os from "node:os";
import { AdapterRegistry } from "../src/adapters/registry.ts";

const home = os.homedir();
const registry = new AdapterRegistry(home);

const detections = await registry.detectAll();
console.log("=== detection ===");
for (const d of detections) {
  console.log(
    `  ${d.harness.padEnd(12)} ${d.status.padEnd(18)} count=${String(d.sessionCount).padStart(5)}  ${d.root}`,
  );
}

const { sessions, errors } = await registry.listAll(300);
console.log(`\n=== listing: ${sessions.length} sessions, ${errors.length} errors ===`);
if (errors.length) console.log(errors);

const byHarness = new Map();
for (const s of sessions) {
  byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
}
for (const [h, n] of [...byHarness].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${h.padEnd(12)} ${n}`);
}

console.log("\n=== sample per harness ===");
const seen = new Set();
for (const s of sessions) {
  if (seen.has(s.harness)) continue;
  seen.add(s.harness);
  console.log(`\n[${s.harness}] ${s.uid}`);
  console.log(`  title   : ${s.title}`);
  console.log(`  when    : ${s.createdAt} -> ${s.updatedAt}`);
  console.log(`  cwd     : ${s.cwd}`);
  console.log(`  repo    : ${s.repo}`);
  console.log(`  model   : ${s.model}`);
  console.log(`  msgs    : ${s.messageCount}  tools: ${s.toolCount}`);
  console.log(`  preview : ${s.preview}`);
  console.log(`  changed : ${JSON.stringify(s.fidelity.filesChanged?.slice(0, 3) ?? null)}`);
  console.log(`  read    : ${JSON.stringify(s.fidelity.filesRead?.slice(0, 3) ?? null)}`);
  console.log(`  notes   : ${JSON.stringify(s.fidelity.notes)}`);
}

console.log("\n=== detail fetch for one session per harness ===");
for (const harness of seen) {
  const s = sessions.find((x) => x.harness === harness);
  const adapter = registry.get(harness);
  if (!s || !adapter) continue;
  const t0 = Date.now();
  const detail = await adapter.getSession(s.nativeId);
  const ms = Date.now() - t0;
  if (!detail) {
    console.log(`  ${harness.padEnd(12)} DETAIL NULL`);
    continue;
  }
  console.log(
    `  ${harness.padEnd(12)} ${String(detail.messages.length).padStart(4)} msgs, ` +
      `${String(detail.tools.length).padStart(3)} distinct tools, ${ms}ms`,
  );
  if (detail.messages[0]) {
    console.log(`      first: [${detail.messages[0].role}] ${detail.messages[0].text.slice(0, 90)}`);
  }
  if (detail.tools[0]) {
    console.log(`      tools: ${detail.tools.slice(0, 5).map((t) => `${t.name}x${t.count}`).join(", ")}`);
  }
}

console.log("\n=== native resume actions ===");
for (const adapter of registry.all()) {
  const s = sessions.find((x) => x.harness === adapter.id);
  if (!s) continue;
  const action = await adapter.buildNativeResume(s.nativeId);
  console.log(
    `  ${adapter.id.padEnd(12)} ${action ? `${action.command} ${action.args.join(" ")}` : "null (no verified command)"}`,
  );
}
