// Render tagged narration as dim italic text, leaving persisted message data unchanged.
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { thinkingShown } from "../../shared/tool-display/index.ts";
import { isNarration } from "./detect.ts";

export const PATCHED = Symbol.for("pi-rig.narration");
const MARK = "▸ ";
const STYLE = { color: (s: string) => `\x1b[2m${s}\x1b[22m`, italic: true };
export const logged = new Set<string>();

/** Log fixed diagnostic labels only, never message text or provider signatures. */
export function logOnce(what: "render fallback" | "updateContent missing") {
  if (logged.has(what)) return;
  logged.add(what);
  try {
    appendFileSync(process.env.PI_NARRATION_LOG || join(homedir(), ".cache", "pi-narration.log"), `${new Date().toISOString()} ${what}\n`);
  } catch {}
}

type State = { wrapper: Function; original: Function; active: boolean; owners: Set<object> };

/** Reinstall above later wrappers; superseded wrappers become inert pass-throughs. */
export function install(proto: any, owner: object): boolean {
  if (typeof proto?.updateContent !== "function") return false;
  const prev: State | undefined = Object.hasOwn(proto, PATCHED) ? proto[PATCHED] : undefined;
  if (prev?.wrapper === proto.updateContent) {
    prev.owners.add(owner);
    return true;
  }
  if (prev) prev.active = false;
  const original = proto.updateContent;
  const state: State = { active: true, original, owners: prev?.owners ?? new Set(), wrapper: () => {} };
  state.owners.add(owner);
  state.wrapper = function (this: any, message: any, ...rest: unknown[]) {
    const content = message?.content;
    if (!state.active || !Array.isArray(content) || !Array.isArray(this.contentContainer?.children)) return state.original.call(this, message, ...rest);
    const narration = new Map<string, string>();
    const mapped = content.map((c: any, i: number) => {
      const text = typeof c?.thinking === "string" ? c.thinking.trim() : "";
      if (!text || !isNarration(c)) return c;
      const key = `\u2060narration-placeholder-${i}\u2060`;
      narration.set(key, text);
      return { type: "text", text: key };
    });
    if (!narration.size) return state.original.call(this, message, ...rest);
    try {
      const result = state.original.call(this, { ...message, content: mapped }, ...rest);
      this.lastMessage = message;
      const children: any[] = this.contentContainer.children;
      let swapped = 0;
      for (let i = 0; i < children.length; i++) {
        const md = children[i];
        const text = typeof md?.text === "string" ? narration.get(md.text) : undefined;
        if (text === undefined) continue;
        children[i] = new md.constructor(MARK + text, md.paddingX, md.paddingY, md.theme, STYLE, md.options);
        swapped++;
      }
      if (swapped !== narration.size) throw new Error("placeholder layout mismatch");
      // The hidden-thinking renderer reports before this wrapper returns. Report the
      // visible narration last so tool groups split at the same visible boundary.
      thinkingShown(message, true, this.hideThinkingBlock === true);
      return result;
    } catch {
      logOnce("render fallback");
      return state.original.call(this, message, ...rest);
    }
  };
  proto.updateContent = state.wrapper;
  proto[PATCHED] = state;
  return true;
}

/** Restore the previous renderer if still outermost; otherwise leave an inert wrapper. */
export function release(proto: any, owner: object): void {
  const state: State | undefined = Object.hasOwn(proto, PATCHED) ? proto[PATCHED] : undefined;
  if (!state?.owners.delete(owner) || state.owners.size) return;
  state.active = false;
  if (proto.updateContent === state.wrapper) proto.updateContent = state.original;
  delete proto[PATCHED];
}
