#!/usr/bin/env node
// Installs the rig's shared Pi config (merged with optional local overrides) into a Pi agent dir.
// settings.json and rig.json are written as merged 0600 files; keybindings.json is a symlink to the shared file.
// All inputs are read and validated before any write; changed outputs are backed up and replaced atomically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const RESOURCE_KEYS = ["packages", "extensions", "skills", "prompts", "themes"];
const FILTER_KEYS = ["extensions", "skills", "prompts", "themes"];
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PRESERVED = /^(~$|~\/|npm:|git:|builtin:|[a-z][a-z0-9+.-]*:\/\/)/i;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));

function rejectPollution(value, label) {
  if (Array.isArray(value)) return value.forEach((v) => rejectPollution(v, label));
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) throw new Error(`${label}: forbidden key "${key}"`);
    rejectPollution(value[key], label);
  }
}

function readJson(file, label, optional) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) {
    if (optional && e.code === "ENOENT" && !lstatOrNull(file)) return null;
    throw new Error(`${label}: cannot read`);
  }
  if (!stat.isFile()) throw new Error(`${label}: not a regular file`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${label}: invalid JSON`); }
  if (!isPlainObject(value)) throw new Error(`${label}: must be a JSON object`);
  rejectPollution(value, label);
  const real = fs.realpathSync(file);
  return { value, base: path.dirname(real), real, parent: realish(path.dirname(file)) };
}

function resolveEntry(entry, base) {
  const prefix = /^[+\-!]/.test(entry) ? entry[0] : "";
  const rest = entry.slice(prefix.length);
  if (!rest || PRESERVED.test(rest) || path.isAbsolute(rest)) return entry;
  return prefix + path.resolve(base, rest);
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

// Validates top-level resource arrays and returns them with relative paths resolved against `base`.
function resolveResources(settings, base, label) {
  const out = {};
  for (const key of RESOURCE_KEYS) {
    if (!(key in settings)) continue;
    const list = settings[key];
    if (!Array.isArray(list)) throw new Error(`${label}: "${key}" must be an array`);
    out[key] = list.map((item) => {
      if (typeof item === "string") return resolveEntry(item, base);
      if (key === "packages" && isPlainObject(item) && typeof item.source === "string" &&
          Object.keys(item).every((k) => k === "source" || k === "autoload" || FILTER_KEYS.includes(k)) &&
          (!("autoload" in item) || typeof item.autoload === "boolean") &&
          FILTER_KEYS.every((k) => !(k in item) || isStringArray(item[k]))) {
        return { ...item, source: resolveEntry(item.source, base) };
      }
      throw new Error(`${label}: invalid "${key}" entry`);
    });
  }
  return out;
}

function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

function mergeSettings(shared, local) {
  const sharedRes = resolveResources(shared.value, shared.base, "shared settings.json");
  const localRes = local ? resolveResources(local.value, local.base, "local settings.json") : {};
  const merged = deepMerge(shared.value, local?.value ?? {});
  for (const key of RESOURCE_KEYS) {
    if (key in sharedRes || key in localRes) merged[key] = [...(sharedRes[key] ?? []), ...(localRes[key] ?? [])];
  }
  return merged;
}

// Real path of `p` even when its tail does not exist yet.
function realish(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
  }
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function currentMatches(dest, want) {
  const st = lstatOrNull(dest);
  if (!st) return false;
  if (want.kind === "symlink") return st.isSymbolicLink() && fs.readlinkSync(dest) === want.target;
  return st.isFile() && (st.mode & 0o777) === 0o600 && fs.readFileSync(dest, "utf8") === want.content;
}

function tmpPath(dir, name) {
  return path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

function writeRegular0600(file, data) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, data); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicReplace(dir, name, want) {
  const tmp = tmpPath(dir, name);
  try {
    if (want.kind === "symlink") fs.symlinkSync(want.target, tmp);
    else writeRegular0600(tmp, want.content);
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Captures an existing output's contents and symlink target; only a dangling symlink may lack contents.
function readOld(file) {
  const entry = {};
  if (fs.lstatSync(file).isSymbolicLink()) entry.symlinkTarget = fs.readlinkSync(file);
  try { entry.data = fs.readFileSync(file); } catch (e) {
    if (!(entry.symlinkTarget !== undefined && e.code === "ENOENT")) throw new Error("existing output: cannot read");
  }
  return entry;
}

function backupRoot(agentDir) {
  const root = path.join(agentDir, "config-backups");
  const st = lstatOrNull(root);
  if (st && !(st.isDirectory() && !st.isSymbolicLink())) throw new Error("config-backups: not a directory");
  return root;
}

function backup(root, olds) {
  if (!lstatOrNull(root)) fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const dir = fs.mkdtempSync(path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  fs.chmodSync(dir, 0o700);
  const manifest = {};
  for (const [name, { symlinkTarget, data }] of Object.entries(olds)) {
    if (data !== undefined) writeRegular0600(path.join(dir, name), data);
    manifest[name] = { path: path.join(path.dirname(root), name), ...(symlinkTarget !== undefined && { symlinkTarget }), copied: data !== undefined };
  }
  writeRegular0600(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

export function installConfig({
  agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
  localDir = path.join(os.homedir(), "local-dotfiles", "pi"),
  configDir = fileURLToPath(new URL("../config", import.meta.url)),
  dryRun = false,
  check = false,
} = {}) {
  // Read and validate everything first.
  const shared = {
    settings: readJson(path.join(configDir, "settings.json"), "shared settings.json"),
    rig: readJson(path.join(configDir, "rig.json"), "shared rig.json"),
    keybindings: readJson(path.join(configDir, "keybindings.json"), "shared keybindings.json"),
  };
  const local = {
    settings: readJson(path.join(localDir, "settings.json"), "local settings.json", true),
    rig: readJson(path.join(localDir, "rig.json"), "local rig.json", true),
  };
  const serialize = (v) => JSON.stringify(v, null, 2) + "\n";
  const wants = {
    "settings.json": { kind: "file", content: serialize(mergeSettings(shared.settings, local.settings)) },
    "rig.json": { kind: "file", content: serialize(deepMerge(shared.rig.value, local.rig?.value ?? {})) },
    "keybindings.json": { kind: "symlink", target: path.resolve(configDir, "keybindings.json") },
  };

  // The agent dir must not be any source's directory (declared or physical), so outputs never overwrite sources.
  // Existing output symlinks pointing at sources are fine: rename replaces the link, not its target.
  const agentReal = realish(agentDir);
  const inputs = [...Object.values(shared), ...Object.values(local)].filter(Boolean);
  const sourceDirs = [realish(configDir), realish(localDir), ...inputs.flatMap((i) => [i.base, i.parent])];
  if (sourceDirs.includes(agentReal)) throw new Error("agent dir must not be a config source directory");
  for (const name of Object.keys(wants)) {
    const st = lstatOrNull(path.join(agentReal, name));
    if (st && !st.isFile() && !st.isSymbolicLink()) throw new Error(`${name}: existing output is not a file or symlink`);
  }

  const changed = Object.keys(wants).filter((n) => !currentMatches(path.join(agentReal, n), wants[n]));
  const unchanged = Object.keys(wants).filter((n) => !changed.includes(n));
  const result = { agentDir: agentReal, changed, unchanged, backupDir: null, dryRun, check, drift: changed.length > 0 };
  if (dryRun || check || changed.length === 0) return result;

  // Capture everything a backup needs before the first write.
  const olds = Object.fromEntries(changed.filter((n) => lstatOrNull(path.join(agentReal, n)))
    .map((n) => [n, readOld(path.join(agentReal, n))]));
  const root = backupRoot(agentReal);
  fs.mkdirSync(agentReal, { recursive: true, mode: 0o700 });
  if (Object.keys(olds).length) result.backupDir = backup(root, olds);
  for (const name of changed) atomicReplace(agentReal, name, wants[name]);
  return result;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--check") opts.check = true;
    else if ((arg === "--agent-dir" || arg === "--local-dir") && argv[i + 1] !== undefined) {
      opts[arg === "--agent-dir" ? "agentDir" : "localDir"] = argv[++i];
    } else throw new Error("unknown or incomplete argument");
  }
  return opts;
}

const USAGE = "usage: install-config.mjs [--agent-dir PATH] [--local-dir PATH] [--dry-run] [--check]";

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`install-config: ${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    const r = installConfig(opts);
    const verb = r.check ? "drift" : r.dryRun ? "would update" : "updated";
    for (const n of r.changed) console.log(`${n}: ${verb}`);
    for (const n of r.unchanged) console.log(`${n}: current`);
    if (r.backupDir) console.log("backup: created");
    return r.check && r.drift ? 1 : 0;
  } catch (e) {
    console.error(`install-config: error: ${e instanceof Error && !(e instanceof SyntaxError) && !e.code ? e.message : "operation failed"}`);
    return 1;
  }
}

const invoked = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
