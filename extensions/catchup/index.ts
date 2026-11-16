// Estimate the time to catch up while the user reviews earlier replies by quoting them.
import { readFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { formatStatus, replay, type Params, type Tracker, visibleText } from "./core.ts";

const STATUS = "catchup";
const params: Params = JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8"));
const nowS = () => Date.now() / 1000;
const tsOf = (m: any) => (typeof m?.timestamp === "number" ? m.timestamp / 1000 : nowS());

export default function (pi: ExtensionAPI) {
  const settings = rigSettings(getAgentDir()).declare("catchup", [
    { key: "enabled", type: "boolean", default: false, description: "Show the reading catch-up estimate (reload to apply)" },
  ]);
  if (!settings.get("enabled")) return;
  let tracker: Tracker | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shown: string | undefined;

  const refresh = (ctx: ExtensionContext) => {
    if (!tracker) return;
    const now = nowS();
    tracker.expire(now);
    const e = tracker.estimate(now);
    const text = e && formatStatus(e);
    if (text !== shown) ctx.ui.setStatus(STATUS, (shown = text));
  };

  pi.on("session_start", (_e, ctx) => {
    clearInterval(timer);
    tracker = undefined;
    shown = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS, undefined);
    tracker = replay(ctx.sessionManager.getEntries(), nowS(), params);
    refresh(ctx);
    timer = setInterval(() => refresh(ctx), 30_000);
    timer.unref?.();
  });
  pi.on("session_shutdown", (_e, ctx) => {
    clearInterval(timer);
    timer = undefined;
    tracker = undefined;
    shown = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, undefined);
  });
  pi.on("message_start", (e, ctx) => {
    if (!tracker || e.message.role !== "user") return;
    tracker.add("user", visibleText(e.message), tsOf(e.message));
    refresh(ctx);
  });
  pi.on("message_end", (e, ctx) => {
    if (!tracker || e.message.role !== "assistant") return;
    tracker.add("assistant", visibleText(e.message), tsOf(e.message));
    refresh(ctx);
  });
}
