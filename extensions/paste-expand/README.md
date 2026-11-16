# Paste expand

Press **Alt+E** to replace `[paste #N …]` markers in the current draft with the full pasted text, without submitting it. Shows a notice if nothing needs expanding or the editor cannot be reached.

## Settings

```json
{ "paste-expand": { "enabled": true } }
```

Default: `false`. Set in the agent directory's `rig.json` or `/rig`, then `/reload`. TUI only; no tools or commands. Disabled instances register no shortcut.

Reuses the rig's structural editor lookup instead of depending on a fixed root-child position. Expansion still depends on the mounted editor exposing `getExpandedText()` and `setText()`. An empty widget captures the active TUI; shutdown clears that reference and removes the widget.
