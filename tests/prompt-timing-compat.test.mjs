import { test } from "node:test";
import assert from "node:assert/strict";
import { installTiming, releaseTiming } from "../extensions/prompt-timing/index.ts";

// Registry identifiers are required to reproduce the legacy diagnostic's protocol.
const LEGACY_PATCHED = Symbol.for("db-scripts.prompt-timing");
const LEGACY_WRAPPED = Symbol.for("db-scripts.prompt-timing.wrapped");
const METHODS = ["emitInput", "emitBeforeAgentStart", "emit", "emitContext"];
const EVENTS = ["input", "before_agent_start", "agent_start", "turn_start", "context"];

// The legacy patch is irreversible and recognizes only its own handler marker.
function installLegacy(proto) {
  if (proto[LEGACY_PATCHED]) return;
  const state = { start: 0, spans: [] };
  const wrappers = new WeakSet();
  function wrapAll(runner) {
    for (const ext of runner.extensions ?? []) {
      for (const event of EVENTS) {
        const list = ext.handlers?.get(event);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const handler = list[i];
          if (handler[LEGACY_WRAPPED]) continue;
          const wrapper = async (...args) => {
            if (!state.start) return handler(...args);
            const start = performance.now();
            try { return await handler(...args); }
            finally { state.spans.push({ ms: performance.now() - start }); }
          };
          wrapper[LEGACY_WRAPPED] = true;
          wrappers.add(wrapper);
          list[i] = wrapper;
        }
      }
    }
  }
  for (const key of METHODS) {
    const original = proto[key];
    proto[key] = function (...args) {
      if (key === "emitInput" && args[2] === "interactive") {
        state.start = performance.now();
        state.spans = [];
      }
      wrapAll(this);
      return original.apply(this, args);
    };
  }
  proto[LEGACY_PATCHED] = true;
  return { wrappers };
}

function fixture() {
  let calls = 0;
  const handler = async () => { calls++; return "handled"; };
  class Runner {
    extensions = [{ path: "example.ts", handlers: new Map([["input", [handler]]]) }];
    async emitInput() { return this.extensions[0].handlers.get("input")[0](); }
    emitBeforeAgentStart() {}
    emit() {}
    emitContext() {}
  }
  return { Runner, handler, calls: () => calls };
}

for (const legacyFirst of [true, false]) {
  test(`mixed timing versions keep handler depth bounded (${legacyFirst ? "legacy" : "current"} first)`, async () => {
    const { Runner, calls } = fixture();
    const proto = Runner.prototype, owner = {};
    const options = { log() {} };
    let legacy;
    if (legacyFirst) legacy = installLegacy(proto);
    const before = Object.fromEntries(METHODS.map((key) => [key, proto[key]]));
    installTiming(proto, owner, options);
    const runner = new Runner();
    // Exercise both current wrappers seen by legacy and legacy wrappers seen by current.
    if (!legacyFirst) runner.emit({});
    const currentWrapped = runner.extensions[0].handlers.get("input")[0];
    if (!legacyFirst) legacy = installLegacy(proto);
    const runners = [runner, new Runner()];
    try {
      if (legacyFirst) {
        for (const key of METHODS) assert.equal(proto[key], before[key], "do not patch over legacy methods");
      }
      for (const current of runners) {
        assert.equal(await current.emitInput("", [], "interactive"), "handled");
        const wrapped = current.extensions[0].handlers.get("input")[0];
        if (!legacyFirst && current === runner) {
          assert.equal(wrapped, currentWrapped, "legacy must not wrap current handlers");
        } else {
          assert.ok(legacy.wrappers.has(wrapped), "current must not wrap legacy handlers");
        }
        for (let i = 0; i < 100; i++) {
          for (const key of METHODS.slice(1)) current[key]();
          assert.equal(current.extensions[0].handlers.get("input")[0], wrapped, "dispatch must not add wrapper layers");
          assert.equal(await current.emitInput("", [], "interactive"), "handled");
        }
      }
      assert.equal(calls(), 202);
    } finally { releaseTiming(proto, owner); }
    for (let i = 0; i < 10; i++) {
      const childOwner = {};
      const methods = METHODS.map((key) => proto[key]);
      installTiming(proto, childOwner, options);
      assert.deepEqual(METHODS.map((key) => proto[key]), methods);
      assert.equal(await runner.emitInput("", [], "interactive"), "handled");
      releaseTiming(proto, childOwner);
    }
    assert.equal(calls(), 212);
  });
}

test("independent module loads share ownership and restore wrappers across release cycles", async () => {
  const other = await import("../extensions/prompt-timing/index.ts?independent-load");
  const { Runner, handler, calls } = fixture();
  const proto = Runner.prototype, original = proto.emitInput;
  const runner = new Runner(), a = {}, b = {};
  for (let cycle = 0; cycle < 10; cycle++) {
    try {
      installTiming(proto, a, { log() {} });
      const method = proto.emitInput;
      other.installTiming(proto, b);
      installTiming(proto, a);
      assert.equal(proto.emitInput, method);
      assert.equal(await runner.emitInput("", [], "interactive"), "handled");
      const wrapped = runner.extensions[0].handlers.get("input")[0];
      releaseTiming(proto, a);
      assert.equal(proto.emitInput, method);
      assert.equal(await runner.emitInput("", [], "interactive"), "handled");
      assert.equal(runner.extensions[0].handlers.get("input")[0], wrapped);
    } finally {
      releaseTiming(proto, a);
      other.releaseTiming(proto, b);
    }
    assert.equal(proto.emitInput, original);
    assert.equal(runner.extensions[0].handlers.get("input")[0], handler);
  }
  assert.equal(calls(), 20);
});
