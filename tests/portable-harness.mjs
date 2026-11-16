// Minimal isolated extension registrations and UI state, using only standard-library helpers.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sandbox(t, settings = {}) {
  const box = mkdtempSync(join(tmpdir(), "pi-portable-"));
  const agentDir = join(box, "agent");
  mkdirSync(agentDir);
  const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_NARRATION_LOG"].map((key) => [key, process.env[key]]));
  const key = Symbol.for("pi-rig.settings");
  const prior = globalThis[key];
  delete globalThis[key];
  Object.assign(process.env, { HOME: box, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_NARRATION_LOG: join(box, "narration.log") });
  writeFileSync(join(agentDir, "rig.json"), JSON.stringify(settings));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
    rmSync(box, { recursive: true, force: true });
  });
  return { box, agentDir };
}

export function registrations(factory) {
  const handlers = new Map();
  const shortcuts = new Map();
  factory({
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => list.splice(list.indexOf(handler), 1);
    },
    registerShortcut: (name, definition) => shortcuts.set(name, definition),
  });
  return { handlers, shortcuts };
}

export async function emit(extension, name, event, ctx) {
  for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
}

export function fakeUI() {
  const state = { editor: "", notices: [], statuses: new Map(), widgets: new Map(), input: undefined, root: { children: [] } };
  const ctx = {
    mode: "tui", hasUI: true,
    sessionManager: { getEntries: () => [] },
    ui: {
      getEditorText: () => state.editor,
      setEditorText: (text) => { state.editor = text; },
      notify: (message, kind) => state.notices.push([kind, message]),
      setStatus: (name, text) => state.statuses.set(name, text),
      setWidget: (name, factory) => {
        if (factory === undefined) state.widgets.delete(name);
        else state.widgets.set(name, typeof factory === "function" ? factory(state.root) : factory);
      },
      onTerminalInput: (handler) => { state.input = handler; return () => { state.input = undefined; }; },
    },
  };
  return { state, ctx };
}
