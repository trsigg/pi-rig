import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import promptStash from "../extensions/prompt-stash/index.ts";
import pasteExpand from "../extensions/paste-expand/index.ts";
import { emit, fakeUI, registrations, sandbox } from "./portable-harness.mjs";

async function stashSetup(t) {
  sandbox(t, { "prompt-stash": { enabled: true } });
  const ext = registrations(promptStash);
  const { ctx, state } = fakeUI();
  await emit(ext, "session_start", {}, ctx);
  t.after(() => emit(ext, "session_shutdown", {}, ctx));
  const stash = () => ext.shortcuts.get("ctrl+s").handler(ctx);
  const enter = async (submit = true) => { state.input("\r"); if (submit) state.editor = ""; await sleep(10); };
  return { ext, ctx, state, stash, enter };
}

test("Ctrl+S restores newest first, manually or after a queued prompt clears the editor", async (t) => {
  const { state, stash, enter } = await stashSetup(t);
  stash();
  assert.deepEqual(state.notices.pop(), ["warning", "Nothing stashed"]);
  for (const text of ["first draft", "second draft"]) { state.editor = text; stash(); assert.equal(state.editor, ""); }
  state.editor = "intervening prompt";
  await enter();
  assert.equal(state.editor, "second draft");
  state.editor = "";
  stash();
  assert.equal(state.editor, "first draft");
});

test("slash commands, non-Enter, failed submits, and new typing never replace a draft", async (t) => {
  const { state, stash, enter } = await stashSetup(t);
  state.editor = "kept"; stash();
  state.editor = "/tree"; await enter();
  assert.equal(state.editor, "");
  await enter();
  state.editor = "typing"; state.input("x"); await sleep(10);
  assert.equal(state.editor, "typing");
  await enter(false);
  assert.equal(state.editor, "typing");
  state.input("\r"); state.editor = "new typing"; await sleep(10);
  assert.equal(state.editor, "new typing");
  state.editor = ""; stash();
  assert.equal(state.editor, "kept");
});

test("stale context and shutdown cancel restoration without throwing or retaining input listeners", async (t) => {
  const { ext, ctx, state, stash } = await stashSetup(t);
  state.editor = "draft"; stash(); state.editor = "prompt";
  state.input("\r");
  ctx.ui.getEditorText = () => { throw new Error("stale context"); };
  await sleep(10);
  await emit(ext, "session_shutdown", {}, ctx);
  assert.equal(state.input, undefined);
});

test("paste expansion uses the mounted editor even when its slot moves, and releases TUI state", async (t) => {
  sandbox(t, { "paste-expand": { enabled: true } });
  const ext = registrations(pasteExpand);
  const { ctx, state } = fakeUI();
  const editor = { onSubmit() {}, handleInput() {}, getText: () => state.editor, setText: (text) => { state.editor = text; }, getExpandedText: () => state.editor.replace("[paste #1 +20 lines]", "expanded lines") };
  state.root.children = [{ children: [] }, { children: [editor] }];
  await emit(ext, "session_start", {}, ctx);
  const expand = () => ext.shortcuts.get("alt+e").handler(ctx);
  state.editor = "see [paste #1 +20 lines]";
  expand(); assert.equal(state.editor, "see expanded lines");
  expand(); assert.match(state.notices.pop()[1], /No pasted-text/);
  const replacement = { ...editor, getExpandedText: () => "replacement editor" };
  state.root.children = [{ children: [] }, { children: [] }, { children: [replacement] }];
  expand(); assert.equal(state.editor, "replacement editor");
  state.root.children = [];
  expand(); assert.match(state.notices.pop()[1], /Can't reach/);
  await emit(ext, "session_shutdown", {}, ctx);
  assert.equal(state.widgets.size, 0);
  expand(); assert.match(state.notices.pop()[1], /Can't reach/);
});
