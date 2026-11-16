// Real Pi loader coverage with an isolated agent directory and no model/auth runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, DefaultResourceLoader, ExtensionRunner, SettingsManager, TreeSelectorComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { emit, fakeUI, sandbox } from "./portable-harness.mjs";

const names = ["catchup", "narration", "prompt-stash", "paste-expand", "tree-compact", "prompt-timing"];
const root = fileURLToPath(new URL("../", import.meta.url));
const paths = names.map((name) => resolve(root, "extensions", name, "index.ts"));
const methods = () => [AssistantMessageComponent.prototype.updateContent, TreeSelectorComponent.prototype.render, ...["emitInput", "emitBeforeAgentStart", "emit", "emitContext"].map((k) => ExtensionRunner.prototype[k])];

async function load(t, settings) {
  const { box, agentDir } = sandbox(t, settings);
  const loader = new DefaultResourceLoader({
    cwd: box, agentDir, settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 6);
  return extensions;
}

test("Pi 1.5 loader imports all six default-disabled extensions without patches, timers, or shortcuts", async (t) => {
  assert.equal(VERSION, "1.5.0");
  const before = methods();
  const oldInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...args) => { intervals++; return oldInterval(...args); };
  t.after(() => { globalThis.setInterval = oldInterval; });
  const extensions = await load(t, {});
  const { ctx } = fakeUI();
  for (const ext of extensions) {
    assert.equal(ext.handlers.size, 0);
    assert.equal(ext.shortcuts.size, 0);
    assert.equal(ext.tools.size, 0);
    assert.equal(ext.commands.size, 0);
    await emit(ext, "session_start", {}, ctx);
  }
  assert.deepEqual(methods(), before);
  assert.equal(intervals, 0);
  const sections = globalThis[Symbol.for("pi-rig.settings")].sections();
  assert.deepEqual(sections.map((s) => s.name).sort(), [...names].sort());
  for (const section of sections) assert.equal(section.get("enabled"), false);
});

test("enabled extensions load through Pi and clean up listeners, timers, widgets, and prototype wrappers", async (t) => {
  const before = methods();
  const extensions = await load(t, Object.fromEntries(names.map((name) => [name, { enabled: true }])));
  assert.deepEqual(methods(), before, "even enabled factories defer patches until session_start");
  const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval;
  const active = new Set();
  globalThis.setInterval = () => { const token = { unref() {} }; active.add(token); return token; };
  globalThis.clearInterval = (token) => { active.delete(token); };
  const { ctx, state } = fakeUI();
  const shutdown = async () => { for (const ext of [...extensions].reverse()) await emit(ext, "session_shutdown", {}, ctx); };
  t.after(async () => { await shutdown(); globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; });
  for (const ext of extensions) await emit(ext, "session_start", {}, ctx);
  assert.equal(active.size, 1);
  assert.equal(typeof state.input, "function");
  assert.equal(state.widgets.size, 1);
  assert.notEqual(AssistantMessageComponent.prototype.updateContent, before[0]);
  assert.notEqual(TreeSelectorComponent.prototype.render, before[1]);
  assert.notEqual(ExtensionRunner.prototype.emitInput, before[2]);
  await shutdown();
  assert.equal(active.size, 0);
  assert.equal(state.input, undefined);
  assert.equal(state.widgets.size, 0);
  assert.deepEqual(methods(), before);
});

test("portable extension import closure stays inside this package or uses host modules and Node built-ins", () => {
  const visited = new Set();
  const host = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    assert.ok(path.startsWith(root), path);
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\/home\/|\/Users\/|~\/notes\/|~\/blobs\//);
    for (const match of text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        assert.ok(target.startsWith(root + "extensions" + sep) || target.startsWith(root + "shared" + sep), target);
        visit(target);
      } else assert.ok(specifier.startsWith("node:") || host.has(specifier), specifier);
    }
  }
  paths.forEach(visit);
  assert.ok(visited.size > paths.length, "checks transitive shared imports too");
});
