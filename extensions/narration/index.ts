// Display tagged narration even while ordinary thinking is hidden.
import { AssistantMessageComponent, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { install, logOnce, release } from "./patch.ts";

export default function (pi: ExtensionAPI) {
  const settings = rigSettings(getAgentDir()).declare("narration", [
    { key: "enabled", type: "boolean", default: false, description: "Render tagged narration as visible text (reload to apply)" },
  ]);
  if (!settings.get("enabled")) return;
  const proto = AssistantMessageComponent?.prototype;
  const owner = {};
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!install(proto, owner)) {
      logOnce("updateContent missing");
      ctx.ui.notify("narration: Pi's renderer changed; using ordinary thinking rendering", "warning");
    }
  });
  pi.on("session_shutdown", () => release(proto, owner));
}
