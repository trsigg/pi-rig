# Prompt stash

Keeps a stack of prompt drafts in memory while you send an intervening prompt.

## Keys

- **Ctrl+S with text:** stash the draft and clear the editor.
- **Ctrl+S in an empty editor:** restore the newest stashed draft.
- After the next non-slash prompt submission clears the editor, restore the newest draft automatically. Slash commands, empty submissions, and intercepted Enter presses do not pop the stash.

Watches terminal Enter rather than the model-input event, so restoration still works when the queue extension handles a busy-session prompt. The delayed restore never replaces a nonempty editor.

## Settings

```json
{ "prompt-stash": { "enabled": true } }
```

Default: `false`. Set in the agent directory's `rig.json` or `/rig`, then `/reload`. TUI only; no tools or commands. Disabled instances register no shortcut.

Drafts are not persisted and are lost on runtime replacement, reload, or exit. Shutdown releases the terminal-input listener and pending restore timer.
