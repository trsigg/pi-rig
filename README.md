# pi-rig

Customized Pi extensions maintained as a lightweight monorepo. Every extension is rebuilt here from a behaviour spec; upstream provenance (SOURCE and LICENSE) is recorded in `upstream/`. The extensions target Pi 1.5.0, pinned in `package.json`.

## Install

```sh
pi install /path/to/pi-rig
```

The six opt-in extensions below are disabled by default. Enable them individually in `rig.json`; each extension's README lists its setting.

## Portable configuration

`config/settings.json`, `config/rig.json` and `config/keybindings.json` are the shared source of truth. The supplied rig config enables all six opt-in extras. Keep machine-specific overrides in optional `settings.json` and `rig.json` files under `~/local-dotfiles/pi` (regular files or symlinks).

Regenerate explicitly after editing either source; this is not a startup hook, core patch or reload extension:

```sh
node ~/pi-rig/scripts/install-config.mjs [--agent-dir PATH] [--local-dir PATH] [--dry-run] [--check]
```

The agent directory defaults to `$PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`; the local directory defaults to `~/local-dotfiles/pi`. Shared files are located relative to the installer, not the working directory. `--dry-run` reports whether changes are needed without writing; `--check` also exits 1 for drift (0 when current). Errors exit nonzero without printing configuration values.

Local scalars win, objects merge recursively and ordinary arrays replace. Settings resource arrays (`packages`, `extensions`, `skills`, `prompts`, `themes`) concatenate shared first, local second, without deduplication. Relative resource paths resolve against the declaring file's **physical location** (after following source symlinks), not the symlink's directory. Package resource filters stay package-relative. Leading `~`, package references and URLs keep their meaning.

The installer creates private regular `settings.json` and `rig.json` outputs, and links `keybindings.json` directly to the shared file (no local keybindings merge). It replaces existing output symlinks instead of writing through them. Changed outputs are backed up under the agent directory's private `config-backups/<unique-run>/`, including linked file contents and a manifest recording original symlink targets. An unchanged rerun makes no backup. Backups may contain sensitive local settings; do not publish them.

Generated settings and rig files are **not canonical**. Pi settings UI, `/rig` and runtime changes persist there until the next installer run; that run backs them up and reapplies shared/local sources. Move desired changes into the appropriate source before regenerating. There is no automatic reverse sync. Keybindings edits through the live symlink edit the shared source directly. Restart Pi after regenerating; the installer does not alter a running session.

## Extensions

| Extension | What it is for | Spec |
|---|---|---|
| [ponytail](extensions/ponytail/README.md) | Always-on guidance to build the simplest working solution, plus the `ponytail-audit` skill | [#37](https://github.com/aakshintala/pi-rig/issues/37) |
| [status](extensions/status/README.md) | Width-aware footer (model, usage, context, git, quotas, speed and extension statuses), plus quota headroom via `get_quotas` and `/quota` | [#38](https://github.com/aakshintala/pi-rig/issues/38) |
| [rig](extensions/rig/README.md) | `/rig` settings menu over every extension's `rig.json` section | [#32](https://github.com/aakshintala/pi-rig/issues/32) |
| [fleet](extensions/fleet/README.md) | FleetView groups running shells, shows linked agent activity, clears finished work after 10 seconds, and provides a viewer, notices and Ctrl+B | [#29](https://github.com/aakshintala/pi-rig/issues/29) |
| [tool-display](extensions/tool-display/README.md) | Groups tool calls into static live summaries (Pi's editor owns the spinner); Ctrl+O or a click reveals errors, while built-in `read`, `edit` and `write` show call lines and edit diffs | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [working](extensions/working/README.md) | Shows a glimmering Thinking or Running tool label and elapsed time in Pi's editor border | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [todo](extensions/todo/README.md) | `todo_write` keeps a TODO list; a compact row above the editor expands on click or `/todos` | [#28](https://github.com/aakshintala/pi-rig/issues/28) |
| [search](extensions/search/README.md) | `grep` and `find` served by Pi's built-ins, or the FFF native index when `search.disabled` is false | [#35](https://github.com/aakshintala/pi-rig/issues/35) |
| [stamp](extensions/stamp/README.md) | One compact duration and completion-time line per settled agent run | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [ask-user](extensions/ask-user/README.md) | `ask_user`: questions in a bottom panel with inline free text | [#34](https://github.com/aakshintala/pi-rig/issues/34) |
| [queue](extensions/queue/README.md) | Steering and follow-ups above other widgets; retrieve a row to edit, or abort and send queued steering | [#39](https://github.com/aakshintala/pi-rig/issues/39) |
| [usage](extensions/usage/README.md) | `/usage`: cost and token usage across sessions, as a graph or a table per period | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [context](extensions/context/README.md) | `/context`: context usage map and injections inspector | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [clear](extensions/clear/README.md) | `/clear`: starts a new session, as `/new` does | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [theme](extensions/theme/README.md) | `/theme`: Pi's own theme picker with live preview | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [inline-skills](extensions/inline-skills/README.md) | `/skill-name` anywhere in a prompt loads that skill, with mid-prompt autocomplete | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [subagents](extensions/subagents/README.md) | Background subagents via `subagent_spawn`, `subagent_message` and `subagent_stop`, nested up to a depth cap, optionally forked or in their own git worktree, with results pushed as notices and a transcript in the viewer | [#26](https://github.com/aakshintala/pi-rig/issues/26) |
| [jobs](extensions/jobs/README.md) | `bash` that moves long commands to the background, and `jobs` to list, wait on and stop them | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
| [monitor](extensions/monitor/README.md) | `monitor`: a watch command whose output lines reach the agent as rate-limited notices | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
| [catchup](extensions/catchup/README.md) | Opt-in footer estimate of unread assistant output and time to catch up | — |
| [narration](extensions/narration/README.md) | Opt-in styled rendering of narration blocks without changing stored messages | — |
| [prompt-stash](extensions/prompt-stash/README.md) | Opt-in Ctrl+S prompt stack, restored after the next non-command submit | — |
| [paste-expand](extensions/paste-expand/README.md) | Opt-in Alt+E expansion of paste markers in the editor | — |
| [tree-compact](extensions/tree-compact/README.md) | Opt-in compact tree labels with times, model names and distinct custom-message colors | — |
| [prompt-timing](extensions/prompt-timing/README.md) | Opt-in local diagnostic log of prompt display and handler latency | — |
