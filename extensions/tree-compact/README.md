# Tree compact

Changes `/tree` rows to show local `HH:mm` timestamps, label assistant turns `model:`, and color custom-message labels blue. It does not alter session entries or tree navigation.

## Settings

```json
{ "tree-compact": { "enabled": true } }
```

Default: `false`. Set in the agent directory's `rig.json` or `/rig`, then `/reload`. TUI only; no tools, commands, or keys.

## Compatibility

Uses a guarded patch of Pi's tree selector and its private row renderer. The row patch is installed lazily on the selector's first render. Unknown renderer shapes keep Pi's default labels.

Patches are process-wide while an enabled session owns them. Last-owner shutdown restores methods that are still outermost and leaves any subsequently wrapped methods inert.
