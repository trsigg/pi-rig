// Alt+E expands paste markers in place without submitting the draft.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { findEditor } from "../../shared/tui/index.ts";

type Editor = { getExpandedText?: () => string; getText: () => string; setText: (text: string) => void };

export default function (pi: ExtensionAPI) {
  const settings = rigSettings(getAgentDir()).declare("paste-expand", [
    { key: "enabled", type: "boolean", default: false, description: "Expand paste markers with Alt+E (reload to apply)" },
  ]);
  if (!settings.get("enabled")) return;
  let tui: unknown;

  pi.on("session_start", (_e, ctx) => {
    tui = undefined;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("paste-expand", (root) => {
      tui = root;
      return { render: () => [], invalidate() {} };
    });
  });
  pi.on("session_shutdown", (_e, ctx) => {
    tui = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("paste-expand", undefined);
  });

  pi.registerShortcut("alt+e", {
    description: "Expand pasted-text markers ([paste #N …]) in the editor",
    handler: (ctx) => {
      if (ctx.mode !== "tui") return;
      const editor = findEditor(tui) as Editor | undefined;
      if (typeof editor?.getExpandedText !== "function" || typeof editor.setText !== "function") {
        return ctx.ui.notify("Can't reach the editor to expand pastes", "warning");
      }
      const text = editor.getText();
      const expanded = editor.getExpandedText();
      if (expanded === text) return ctx.ui.notify("No pasted-text markers to expand", "info");
      editor.setText(expanded);
    },
  });
}
