# Narration

Renders tagged pre-tool narration as visible dim-italic text with a `▸` marker, even when ordinary thinking is hidden. Persisted messages and signatures remain unchanged.

## Settings

```json
{ "narration": { "enabled": true } }
```

Default: `false`. Set in the agent directory's `rig.json` or `/rig`, then `/reload`. TUI only; no tools, commands, or keys.

## Compatibility

The detector recognizes thinking blocks whose base64 signature contains the bytes `narration`. It is a display heuristic, not signature validation. Tests generate synthetic signatures from explicit marker bytes, not provider captures.

Pi has no public hook for distinguishing hidden thinking blocks during content rendering. This extension wraps `AssistantMessageComponent.updateContent` for enabled TUI sessions and falls back to Pi's normal rendering if the child layout changes. Fixed fallback labels are logged once to `~/.cache/pi-narration.log` (override with `PI_NARRATION_LOG`); message text and signatures are never logged.

The narration wrapper must sit above hidden-thinking wrappers. Tool grouping receives a final visible-thinking report after narration renders, so visible narration separates call groups. The shared patch symbol is `Symbol.for("pi-rig.narration")`.

Patches are process-wide while an enabled session owns them. The last shutdown restores the previous renderer when still outermost, or leaves an inert pass-through if another wrapper has since been installed.
