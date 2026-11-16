import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { isNarration } from "../extensions/narration/detect.ts";
import { install, PATCHED, release } from "../extensions/narration/patch.ts";
import { useHiddenThinking, releaseHiddenThinking } from "../extensions/tool-display/thinking.ts";
import { ToolGroups } from "../shared/tool-display/index.ts";
import { sandbox } from "./portable-harness.mjs";

// Synthetic protobuf-shaped field 8: a length-delimited kind marker, with no captured provider bytes.
const signature = (kind) => Buffer.concat([Buffer.from([0x42, kind.length]), Buffer.from(kind)]).toString("base64");
const narration = (text = "Visible narration line") => ({ type: "thinking", thinking: text, thinkingSignature: signature("narration") });
const reasoning = { type: "thinking", thinking: "Hidden reasoning", thinkingSignature: signature("thinking") };
const call = (id) => ({ type: "toolCall", id, name: "read", arguments: { path: "example.txt" } });
const strip = (s) => s.replace(/\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07/g, "");

test("synthetic marker signatures detect narration, not ordinary thinking or invalid blocks", () => {
  assert.equal(isNarration(narration()), true);
  assert.equal(isNarration(reasoning), false);
  for (const block of [null, {}, { type: "text", thinkingSignature: signature("narration") }, { type: "thinking", thinkingSignature: "" }, { type: "thinking", thinkingSignature: "!!!narration" }, { type: "thinking", thinkingSignature: 42 }]) assert.equal(isNarration(block), false);
});

test("real Pi renders styled narration while hidden reasoning and persisted data stay unchanged", (t) => {
  sandbox(t);
  initTheme("dark");
  class Patched extends AssistantMessageComponent {}
  const proto = Patched.prototype, owner = {};
  const original = proto.updateContent;
  install(proto, owner);
  t.after(() => release(proto, owner));
  const message = { role: "assistant", content: [reasoning, narration(), call("synthetic-call")] };
  const before = JSON.stringify(message);
  const component = new Patched(message, true);
  const raw = component.render(80).join("\n");
  assert.match(strip(raw), /▸ Visible narration line/);
  assert.match(raw, /\x1b\[2m/);
  assert.equal(component.contentContainer.children.find((c) => c.text?.startsWith("▸ "))?.defaultTextStyle.italic, true);
  assert.doesNotMatch(strip(raw), /Hidden reasoning/);
  assert.equal(JSON.stringify(message), before);
  assert.equal(component.lastMessage, message);
  component.setHideThinkingBlock(false);
  assert.match(strip(component.render(80).join("\n")), /Hidden reasoning/);
  assert.match(strip(component.render(80).join("\n")), /▸ Visible narration/);
  release(proto, owner);
  assert.equal(proto.updateContent, original);
});

for (const order of ["narration-first", "hidden-thinking-first"]) {
  test(`visible narration splits real tool groups in ${order} installation order`, (t) => {
    sandbox(t);
    initTheme("dark");
    const proto = AssistantMessageComponent.prototype;
    const original = proto.updateContent;
    const narrationOwner = {}, hiddenOwner = {};
    if (order === "narration-first") { install(proto, narrationOwner); useHiddenThinking(hiddenOwner); }
    else { useHiddenThinking(hiddenOwner); install(proto, narrationOwner); }
    const groups = new ToolGroups();
    t.after(() => { groups.reset(); releaseHiddenThinking(hiddenOwner); release(proto, narrationOwner); });
    assert.equal(proto.updateContent, proto[PATCHED].wrapper, "narration stays outermost");
    const first = { role: "assistant", content: [call("synthetic-first")] };
    const second = { role: "assistant", content: [reasoning, narration(), call("synthetic-second")] };
    groups.track(first); groups.track(second);
    groups.describe("synthetic-first", { verb: "read", many: "files" }, () => {});
    groups.describe("synthetic-second", { verb: "read", many: "files" }, () => {});
    const component = new AssistantMessageComponent(second, true);
    const out = strip(component.render(80).join("\n"));
    assert.match(out, /▸ Visible narration/);
    assert.doesNotMatch(out, /Thinking\.\.\.|Hidden reasoning/);
    assert.deepEqual(groups.group("synthetic-first").calls.map((c) => c.id), ["synthetic-first"]);
    assert.deepEqual(groups.group("synthetic-second").calls.map((c) => c.id), ["synthetic-second"]);
    // Negative control: hidden ordinary reasoning still permits grouping across messages.
    const third = { role: "assistant", content: [reasoning, call("synthetic-third")] };
    groups.track(third);
    groups.describe("synthetic-third", { verb: "read", many: "files" }, () => {});
    new AssistantMessageComponent(third, true).render(80);
    assert.deepEqual(groups.group("synthetic-third").calls.map((c) => c.id), ["synthetic-second", "synthetic-third"]);
    // Release in both orders, with a remaining owner keeping the other patch live.
    if (order === "narration-first") { releaseHiddenThinking(hiddenOwner); release(proto, narrationOwner); }
    else { release(proto, narrationOwner); releaseHiddenThinking(hiddenOwner); }
    assert.equal(proto.updateContent, original);
  });
}

test("layout mismatch falls back, and reinstallation above a later wrapper is reversible", (t) => {
  sandbox(t);
  initTheme("dark");
  class Broken extends AssistantMessageComponent {}
  const proto = Broken.prototype, owner = {};
  const original = proto.updateContent;
  proto.updateContent = function (...args) { original.apply(this, args); for (const child of this.contentContainer.children) if (typeof child.text === "string") child.text = undefined; };
  install(proto, owner);
  const message = { role: "assistant", content: [narration()] };
  const component = new Broken(message, true);
  assert.equal(component.lastMessage, message);
  assert.match(strip(component.render(80).join("\n")), /Thinking\.\.\./);
  release(proto, owner);

  class Layered extends AssistantMessageComponent {}
  const p = Layered.prototype, a = {}, b = {};
  install(p, a);
  const below = p.updateContent;
  const seen = [];
  p.updateContent = function (m, ...rest) { seen.push(m.content.map((c) => c.type)); return below.call(this, m, ...rest); };
  install(p, b);
  install(p, b);
  new Layered(message, true).render(80);
  assert.deepEqual(seen, [["text"]]);
  release(p, a);
  assert.equal(p[PATCHED].active, true);
  release(p, b);
  assert.equal(p[PATCHED], undefined);
});
