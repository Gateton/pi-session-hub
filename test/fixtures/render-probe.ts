/**
 * Test fixture: which API makes extension content visible in the transcript?
 *
 * Not part of the extension. Used to decide whether the imported-context
 * document should be injected with sendMessage, appendEntry, or
 * appendCustomMessageEntry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("probe-msg", (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", "PROBE MESSAGE RENDERED"), 0, 0));
    box.addChild(new Text(String(message.content).slice(0, 60), 0, 0));
    return box;
  });

  pi.registerEntryRenderer("probe-entry", (_entry, { outputPad }, theme) => {
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", "PROBE ENTRY RENDERED"), 0, 0));
    return box;
  });

  pi.registerCommand("p-msg", {
    description: "probe: pi.sendMessage visibility",
    handler: async () => {
      pi.sendMessage(
        { customType: "probe-msg", content: "hello from sendMessage", display: true },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("p-entry", {
    description: "probe: pi.appendEntry visibility",
    handler: async () => {
      pi.appendEntry("probe-entry", { note: "hello from appendEntry" });
    },
  });

  pi.registerCommand("p-session-msg", {
    description: "probe: sessionManager.appendCustomMessageEntry visibility",
    handler: async (_args, ctx) => {
      ctx.sessionManager.appendCustomMessageEntry("probe-msg", "hello from sessionManager", true, {});
    },
  });
}
