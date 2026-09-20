/**
 * Test fixture: how much vertical space does a non-overlay custom UI get?
 *
 * Renders `process.stdout.rows` bordered lines with the row number in each, so a
 * capture shows exactly how many lines survive.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

class Probe {
  render(width: number): string[] {
    const rows = process.stdout.rows ?? 0;
    const out: string[] = [];
    out.push(`TOP rows=${rows} cols=${process.stdout.columns ?? 0} width=${width}`.padEnd(width));
    const body = Math.max(1, rows - 4);
    for (let i = 0; i < body; i++) {
      out.push(`| row ${String(i).padStart(3)}`.padEnd(width));
    }
    out.push(`BOTTOM sentinel`.padEnd(width));
    return out;
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (data === "q") this.done?.();
  }
  done?: () => void;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe-full", {
    description: "probe: full-screen custom UI",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<null>((tui, _theme, _kb, done) => {
        const p = new Probe();
        p.done = () => done(null);
        return {
          render: (w) => p.render(w),
          handleInput: (d) => {
            p.handleInput(d);
            tui.requestRender();
          },
          invalidate: () => p.invalidate(),
        };
      });
    },
  });
}
