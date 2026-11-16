// Compact /tree labels with local HH:mm timestamps and distinct custom-message labels.
import { getAgentDir, TreeSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";

const PATCHED = Symbol.for("pi-rig.tree-compact");
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const BLUE = (s: string) => `\x1b[34m${s}\x1b[39m`;
const SGR = "(?:\\x1b\\[[0-9;:]*m)*";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function recolorLabel(text: string, type: unknown): string {
  if (typeof type !== "string") return text;
  const label = `[${type}]: `;
  return text.replace(new RegExp(`^${SGR}${escapeRe(label)}${SGR}`), BLUE(label));
}

function hhmm(ts: string | number | undefined): string | undefined {
  if (ts === undefined) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type MethodPatch = { proto: any; key: string; original: Function; wrapper: Function };
type State = { owners: Set<object>; active: boolean; patches: MethodPatch[] };

/** Lazily patch TreeList when a selector first renders; share one patch across sessions. */
export function installTree(selector: any, owner: object): boolean {
  if (typeof selector?.render !== "function") return false;
  let state: State | undefined = selector[PATCHED];
  if (state) { state.owners.add(owner); return true; }
  state = { owners: new Set([owner]), active: true, patches: [] };
  const live = state;
  const patch = (proto: any, key: string, wrap: (original: Function) => Function) => {
    const original = proto[key];
    const wrapper = wrap(original);
    live.patches.push({ proto, key, original, wrapper });
    proto[key] = wrapper;
  };
  patch(selector, "render", (original) => function (this: any, ...args: unknown[]) {
    const proto = this.treeList && Object.getPrototypeOf(this.treeList);
    if (live.active && proto && typeof proto.getEntryDisplayText === "function" && !live.patches.some((p) => p.proto === proto)) {
      patch(proto, "getEntryDisplayText", (row) => function (this: any, node: any, selected: boolean) {
        const raw = row.call(this, node, selected);
        if (!live.active || typeof raw !== "string") return raw;
        let text = raw.replace("assistant: ", "model: ");
        if (node?.entry?.type === "custom_message") text = recolorLabel(text, node.entry.customType);
        const time = hhmm(node?.entry?.timestamp);
        return time && text ? `${DIM(time)} ${text}` : text;
      });
    }
    return original.apply(this, args);
  });
  selector[PATCHED] = state;
  return true;
}

export function releaseTree(selector: any, owner: object): void {
  const state: State | undefined = selector?.[PATCHED];
  if (!state?.owners.delete(owner) || state.owners.size) return;
  state.active = false;
  for (const { proto, key, original, wrapper } of state.patches.reverse()) {
    if (proto[key] === wrapper) proto[key] = original;
  }
  delete selector[PATCHED];
}

export default function (pi: ExtensionAPI) {
  const settings = rigSettings(getAgentDir()).declare("tree-compact", [
    { key: "enabled", type: "boolean", default: false, description: "Compact tree labels and add local timestamps (reload to apply)" },
  ]);
  if (!settings.get("enabled")) return;
  const owner = {};
  pi.on("session_start", (_e, ctx) => {
    if (ctx.mode === "tui" && !installTree(TreeSelectorComponent.prototype, owner)) {
      ctx.ui.notify("tree-compact: Pi's tree renderer changed; using default labels", "warning");
    }
  });
  pi.on("session_shutdown", () => releaseTree(TreeSelectorComponent.prototype, owner));
}
