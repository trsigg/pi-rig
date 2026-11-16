// Diagnostic: log submit-to-user-message latency and slow extension handlers, without prompt text.
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ExtensionRunner, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";

const MIN_MS = 20;
const EVENTS = ["input", "before_agent_start", "agent_start", "turn_start", "context"];
const PATCHED = Symbol.for("pi-rig.prompt-timing");
type Clock = { start?: number; spans: { name: string; ms: number }[] };
type MethodPatch = { key: string; original: Function; wrapper: Function };
type HandlerPatch = { list: Function[]; original: Function; wrapper: Function };
type State = { active: boolean; owners: Set<object>; methods: MethodPatch[]; handlers: Set<HandlerPatch> };

const extName = (path: string) => basename(path).startsWith("index.") ? basename(dirname(path)) : basename(path);
const writeLog = (line: string) => {
  const path = join(homedir(), ".cache", "pi-prompt-timing.log");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

/** Share a reversible diagnostic patch; clocks are isolated by ExtensionRunner instance. */
export function installTiming(proto: any, owner: object, { now = () => performance.now(), log = writeLog } = {}): void {
  const prev: State | undefined = proto[PATCHED];
  if (prev) { prev.owners.add(owner); return; }
  const state: State = { active: true, owners: new Set([owner]), methods: [], handlers: new Set() };
  const clocks = new WeakMap<object, Clock>();
  const wrapped = new WeakSet<Function>();
  const clockOf = (runner: object) => {
    let clock = clocks.get(runner);
    if (!clock) clocks.set(runner, (clock = { spans: [] }));
    return clock;
  };
  function wrapAll(runner: any, clock: Clock) {
    for (const ext of runner.extensions ?? []) {
      for (const event of EVENTS) {
        const list: Function[] | undefined = ext.handlers?.get(event);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const original = list[i];
          if (wrapped.has(original)) continue;
          const name = `${extName(ext.path)}:${event}`;
          const wrapper = async (...args: unknown[]) => {
            if (!state.active || clock.start === undefined) return original(...args);
            const start = now();
            const spans = clock.spans;
            try { return await original(...args); }
            finally { spans.push({ name, ms: now() - start }); }
          };
          wrapped.add(wrapper);
          list[i] = wrapper;
          state.handlers.add({ list, original, wrapper });
        }
      }
    }
  }
  function finish(clock: Clock) {
    if (clock.start === undefined) return;
    const total = now() - clock.start;
    const slow = clock.spans.filter((s) => s.ms >= MIN_MS).sort((a, b) => b.ms - a.ms).map((s) => `${s.name}=${Math.round(s.ms)}ms`);
    const handlers = clock.spans.reduce((sum, s) => sum + s.ms, 0);
    clock.start = undefined;
    clock.spans = [];
    log(`enter->shown=${Math.round(total)}ms handlers=${Math.round(handlers)}ms ${slow.join(" ")}`);
  }
  for (const key of ["emitInput", "emitBeforeAgentStart", "emit", "emitContext"]) {
    const original = proto[key];
    if (typeof original !== "function") continue;
    const wrapper = function (this: any, ...args: any[]) {
      if (state.active) {
        const clock = clockOf(this);
        if (key === "emitInput" && args[2] === "interactive") {
          clock.start = now();
          clock.spans = [];
        }
        wrapAll(this, clock);
        if (key === "emit" && args[0]?.type === "message_start" && args[0].message?.role === "user") finish(clock);
      }
      return original.apply(this, args);
    };
    state.methods.push({ key, original, wrapper });
    proto[key] = wrapper;
  }
  proto[PATCHED] = state;
}

export function releaseTiming(proto: any, owner: object): void {
  const state: State | undefined = proto?.[PATCHED];
  if (!state?.owners.delete(owner) || state.owners.size) return;
  state.active = false;
  for (const { key, original, wrapper } of state.methods) if (proto[key] === wrapper) proto[key] = original;
  for (const { list, original, wrapper } of state.handlers) {
    const index = list.indexOf(wrapper);
    if (index !== -1) list[index] = original;
  }
  state.handlers.clear();
  delete proto[PATCHED];
}

export default function (pi: ExtensionAPI) {
  const settings = rigSettings(getAgentDir()).declare("prompt-timing", [
    { key: "enabled", type: "boolean", default: false, description: "Log prompt latency and slow extension handlers (reload to apply)" },
  ]);
  if (!settings.get("enabled")) return;
  const owner = {};
  pi.on("session_start", () => installTiming(ExtensionRunner.prototype, owner));
  pi.on("session_shutdown", () => releaseTiming(ExtensionRunner.prototype, owner));
}
