import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, readlinkSync, lstatSync, readdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const put = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture(t) {
  const box = mkdtempSync(join(tmpdir(), "config-install-"));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const repo = join(box, "rig"), config = join(repo, "config"), local = join(box, "local"), agent = join(box, "agent"), home = join(box, "home");
  for (const dir of [config, local, agent, home, join(repo, "scripts")]) mkdirSync(dir, { recursive: true });
  cpSync(join(root, "scripts/install-config.mjs"), join(repo, "scripts/install-config.mjs"));
  put(join(config, "settings.json"), {});
  put(join(config, "rig.json"), {});
  put(join(config, "keybindings.json"), { "app.interrupt": ["alt+c"] });
  function run(...args) {
    return spawnSync(process.execPath, [join(repo, "scripts/install-config.mjs"), "--agent-dir", agent, "--local-dir", local, ...args], {
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent }, encoding: "utf8", cwd: box,
    });
  }
  return { box, repo, config, local, agent, home, run };
}
function ok(result) { assert.equal(result.status, 0, result.stderr); }
function snapshot(dir) {
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.mode & 0o777, stat.isSymbolicLink() ? ["link", readlinkSync(path)] : stat.isDirectory() ? snapshot(path) : readFileSync(path, "utf8")];
  });
}

test("portable files contain only the intended shared defaults", () => {
  const settings = read(join(root, "config/settings.json"));
  assert.deepEqual(settings, {
    packages: ["~/pi-rig", "npm:pi-vim", "npm:pi-btw", "npm:pi-sticky-header"],
    theme: "dark", compaction: { enabled: true, reserveTokens: 50000 }, steeringMode: "all", followUpMode: "all",
    transport: "auto", markdown: { mermaid: "streaming" }, tuiMode: "fullscreen", defaultThinkingLevel: "medium", cacheWarming: "idle",
  });
  assert.deepEqual(read(join(root, "config/rig.json")), {
    jobs: { maxWaitSeconds: 300 }, ...Object.fromEntries(["catchup", "narration", "prompt-stash", "paste-expand", "tree-compact"].map((key) => [key, { enabled: true }])),
    "prompt-timing": { enabled: false },
  });
  assert.deepEqual(read(join(root, "config/keybindings.json")), {
    "tui.editor.cursorLeft": ["left"], "app.models.save": ["alt+s"], "app.thinking.save": ["alt+s"], "app.session.toggleSort": ["alt+s"], "app.interrupt": ["alt+c"],
  });
});

test("merges objects, replaces ordinary arrays, concatenates resources in order", (t) => {
  const f = fixture(t);
  put(join(f.config, "settings.json"), { theme: "dark", compaction: { enabled: true, reserveTokens: 12 }, enabledModels: ["old"], packages: ["npm:one"], extensions: ["./ext"], skills: ["~/skills"], prompts: ["./prompts"], themes: ["./themes"] });
  put(join(f.local, "settings.json"), { theme: "light", compaction: { reserveTokens: 20 }, enabledModels: ["new"], packages: ["npm:one", { source: "./pkg", autoload: false, extensions: ["./index.ts", "!old/*"] }], extensions: ["-builtin:mcp"], skills: ["./skills"], prompts: ["~/prompts"], themes: [] });
  put(join(f.config, "rig.json"), { jobs: { maxWaitSeconds: 300, extra: true }, ordinary: [1] });
  put(join(f.local, "rig.json"), { jobs: { maxWaitSeconds: 10 }, ordinary: [2] });
  ok(f.run());
  assert.deepEqual(read(join(f.agent, "settings.json")), {
    theme: "light", compaction: { enabled: true, reserveTokens: 20 }, enabledModels: ["new"],
    packages: ["npm:one", "npm:one", { source: join(f.local, "pkg"), autoload: false, extensions: ["./index.ts", "!old/*"] }],
    extensions: [join(f.config, "ext"), "-builtin:mcp"], skills: ["~/skills", join(f.local, "skills")],
    prompts: [join(f.config, "prompts"), "~/prompts"], themes: [join(f.config, "themes")],
  });
  assert.deepEqual(read(join(f.agent, "rig.json")), { jobs: { maxWaitSeconds: 10, extra: true }, ordinary: [2] });
});

test("resource bases follow physical sources and keep references and selectors", (t) => {
  const f = fixture(t), physical = join(f.box, "physical");
  mkdirSync(physical);
  const source = join(physical, "settings.json");
  put(source, { packages: ["./pkg", "~/pkg", "npm:one", "git:host/repo", "https://example.org/repo"], extensions: ["+./ext", "-./off", "!./old/*", "builtin:mcp", "-builtin:mcp"] });
  symlinkSync(source, join(f.local, "settings.json"));
  const original = readFileSync(source, "utf8");
  symlinkSync(source, join(f.agent, "settings.json"));
  ok(f.run());
  assert.equal(lstatSync(join(f.agent, "settings.json")).isFile(), true);
  assert.deepEqual(read(join(f.agent, "settings.json")), { packages: [join(physical, "pkg"), "~/pkg", "npm:one", "git:host/repo", "https://example.org/repo"], extensions: [`+${join(physical, "ext")}`, `-${join(physical, "off")}`, `!${join(physical, "old/*")}`, "builtin:mcp", "-builtin:mcp"] });
  assert.equal(readlinkSync(join(f.local, "settings.json")), source);
  assert.equal(readFileSync(source, "utf8"), original);
});

test("absent local files, default directories, private regular outputs and shared keybindings link", (t) => {
  const f = fixture(t);
  rmSync(f.local, { recursive: true });
  const result = spawnSync(process.execPath, [join(f.repo, "scripts/install-config.mjs")], { env: { ...process.env, HOME: f.home, PI_CODING_AGENT_DIR: f.agent }, encoding: "utf8" });
  ok(result);
  for (const name of ["settings.json", "rig.json"]) {
    assert.equal(lstatSync(join(f.agent, name)).isFile(), true);
    assert.equal(lstatSync(join(f.agent, name)).mode & 0o777, 0o600);
  }
  assert.equal(resolve(f.agent, readlinkSync(join(f.agent, "keybindings.json"))), join(f.config, "keybindings.json"));
  assert.equal(existsSync(join(f.agent, "config-backups")), false);
  const noEnv = { ...process.env, HOME: f.home };
  delete noEnv.PI_CODING_AGENT_DIR;
  ok(spawnSync(process.execPath, [join(f.repo, "scripts/install-config.mjs")], { env: noEnv, encoding: "utf8" }));
  assert.equal(existsSync(join(f.home, ".pi/agent/settings.json")), true);
});

test("backs up old linked contents and targets without changing sources", (t) => {
  const f = fixture(t), old = join(f.box, "old-settings.json");
  put(old, { oldValue: "private-placeholder" });
  symlinkSync(old, join(f.agent, "settings.json"));
  put(join(f.agent, "rig.json"), { oldRig: true });
  put(join(f.agent, "keybindings.json"), { oldKeys: true });
  ok(f.run());
  assert.deepEqual(read(old), { oldValue: "private-placeholder" });
  assert.equal(lstatSync(join(f.agent, "settings.json")).isSymbolicLink(), false);
  const backups = join(f.agent, "config-backups");
  assert.equal(lstatSync(backups).mode & 0o777, 0o700);
  assert.equal(readdirSync(backups).length, 1);
  const backup = join(backups, readdirSync(backups)[0]);
  assert.equal(lstatSync(backup).mode & 0o777, 0o700);
  assert.deepEqual(read(join(backup, "settings.json")), { oldValue: "private-placeholder" });
  assert.deepEqual(read(join(backup, "rig.json")), { oldRig: true });
  assert.deepEqual(read(join(backup, "keybindings.json")), { oldKeys: true });
  const manifest = readFileSync(join(backup, "manifest.json"), "utf8");
  assert.ok(manifest.includes(old));
  assert.equal(read(join(backup, "manifest.json"))["settings.json"].path, join(f.agent, "settings.json"));
  for (const name of readdirSync(backup)) {
    assert.equal(lstatSync(join(backup, name)).isFile(), true);
    assert.equal(lstatSync(join(backup, name)).mode & 0o777, 0o600);
  }
  const before = snapshot(f.agent);
  ok(f.run());
  ok(f.run("--check"));
  assert.deepEqual(snapshot(f.agent), before);
  put(join(f.agent, "rig.json"), { runtimeEdit: true });
  ok(f.run());
  assert.equal(readdirSync(backups).length, 2);
  assert.deepEqual(read(join(f.agent, "rig.json")), {});
});

test("dry-run and check never write, report drift, and never print values", (t) => {
  const f = fixture(t), sentinel = "sensitive-placeholder-do-not-print";
  put(join(f.local, "settings.json"), { defaultModel: sentinel });
  const before = snapshot(f.box);
  for (const args of [["--dry-run"], ["--check"], ["--dry-run", "--check"]]) {
    const result = f.run(...args);
    assert.equal(result.status, args.includes("--check") ? 1 : 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(sentinel), false);
    assert.deepEqual(snapshot(f.box), before);
  }
  const applied = f.run();
  ok(applied);
  assert.equal((applied.stdout + applied.stderr).includes(sentinel), false);
  ok(f.run("--check"));
  const unknown = f.run(`--${sentinel}`);
  assert.notEqual(unknown.status, 0);
  assert.equal((unknown.stdout + unknown.stderr).includes(sentinel), false);
  chmodSync(join(f.agent, "settings.json"), 0o644);
  assert.equal(f.run("--check").status, 1);
  ok(f.run());
  assert.equal(lstatSync(join(f.agent, "settings.json")).mode & 0o777, 0o600);
});

test("refuses output directories aliasing sources before changing any input", (t) => {
  const f = fixture(t);
  symlinkSync(f.config, join(f.box, "source-alias"));
  const before = snapshot(f.config);
  const result = f.run("--agent-dir", join(f.box, "source-alias"));
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(f.config), before);
  const source = join(f.agent, "rig.json");
  put(source, { preserve: true });
  symlinkSync(source, join(f.local, "rig.json"));
  const beforeAgent = snapshot(f.agent);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(snapshot(f.agent), beforeAgent);
});

test("all malformed inputs abort before any output mutation and redact diagnostics", (t) => {
  const cases = [
    ["local", "settings.json", '{"private-sentinel":'],
    ["local", "rig.json", '[]'],
    ["local", "settings.json", '{"__proto__":{"polluted":true}}'],
    ["local", "rig.json", '{"nested":{"constructor":{}}}'],
    ["local", "settings.json", '{"packages":[{"source":1}]}'],
    ["local", "settings.json", '{"skills":[{}]}'],
    ["local", "settings.json", '{"packages":[{"source":"./pkg","autoload":"no"}]}'],
    ["local", "settings.json", '{"themes":null}'],
    ["local", "settings.json", '{"packages":[{"source":"./pkg","extensions":[1]}]}'],
    ["config", "settings.json", 'null'],
    ["config", "rig.json", '{"nested":{"prototype":true}}'],
    ["config", "keybindings.json", 'false'],
    ...["settings.json", "rig.json", "keybindings.json"].map((name) => ["config", name, null]),
  ];
  for (const [dir, name, content] of cases) {
    const f = fixture(t);
    put(join(f.agent, "settings.json"), { keep: true });
    put(join(f.agent, "rig.json"), { keep: true });
    const path = join(f[dir], name);
    if (content === null) rmSync(path); else writeFileSync(path, content);
    const before = snapshot(f.agent), result = f.run();
    assert.notEqual(result.status, 0, `${dir}/${name}: ${content}`);
    assert.deepEqual(snapshot(f.agent), before);
    assert.equal((result.stdout + result.stderr).includes("private-sentinel"), false);
    assert.equal({}.polluted, undefined);
  }
});
