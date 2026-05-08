# Changelog

## [Unreleased]

### Fixed

- **Repeated visible message IDs** — `injectMessageIds` now strips previously injected trailing `dcp-id` tags from string content, standalone ID blocks, and embedded trailing tags inside array-backed text blocks before reinjecting fresh IDs, preventing repeated or stale `<dcp-id>mNNN</dcp-id>` lines when the `context` hook is re-run on already-pruned visible messages.

### Changed

- **Global config path moved** — DCP now loads its global user config from `~/.pi/agent/dcp.jsonc` instead of `~/.config/pi/dcp.jsonc`. Existing global configs should be moved to the new path.
- **Above-max nudges now fire immediately** — `context-soft` and `context-strong` nudges fire on every `context` event once usage exceeds `maxContextPercent`. `nudgeFrequency` now only gates the mid-band `turn`/`iteration` nudges between `minContextPercent` and `maxContextPercent`.
- **Hierarchical decompression behavior** — `/dcp decompress N` now understands roll-up parents and reactivates their direct child blocks instead of always flattening back to raw history.
- **True roll-up recompression** — Roll-up placeholders now act as coverage markers instead of expansion macros. The `compress` tool validates bare `(bN)` coverage, rejects placeholders wrapped in inline code spans, fenced code blocks, or indented code blocks, requires substantive authored parent text to remain after those placeholders are removed, and keeps only the newly authored parent summary visible while superseding the child blocks.
- **Roll-up token accounting** — `/dcp context` and `/dcp stats` now report active compression savings only. When a roll-up parent supersedes child blocks, the parent replaces their contribution instead of stacking on top of already-counted child savings.

### Added

- **Minimum compress-range enforcement** (`compress.minRangeMessages`) — when set above `0`, the `compress` tool rejects any range whose visible span is smaller than the configured minimum consecutive conversation items. The default remains `0`, which keeps the feature disabled unless explicitly configured. The span is measured from the currently visible conversation, so raw messages and visible passthrough entries each count as one visible item, and active compressed blocks also count as a single visible item.
- **Compressed-block boundary metadata** — synthetic compressed messages are surfaced as `[Compressed section: <topic>]` and include a `<dcp-block-id>bN</dcp-block-id>` tag so later `compress` calls can reference block boundaries and use `(bN)` placeholders safely.
- **Hierarchical roll-up compression** — compression ranges may now fully contain active compressed blocks, producing a parent block that supersedes those children. Roll-up summaries are strictly validated to require each contained `(bN)` placeholder exactly once, and partial overlap with active blocks is still rejected.

## [1.0.7] - 2026-04-14

### Fixed

- **Infinity anchorTimestamp ghost block spiral** — When a `compress` range extended to the end of the conversation, `resolveAnchorTimestamp` returned `Infinity`. `JSON.stringify(Infinity)` serialises to `null`, so on session restore the corrupted block's timestamps coerced to `0` in JS overlap checks, making every new range appear to overlap the ghost block and trapping the model in a compression spiral (101 failures over 2 hours). `resolveAnchorTimestamp` now returns `endTimestamp + 1` instead of `Infinity`.
- **Corrupted block propagation on session restore** — `index.ts` filters out persisted compression blocks whose `startTimestamp` or `endTimestamp` is non-finite before restoring state. Legacy non-finite `anchorTimestamp` values are tolerated and repaired during restore instead of being treated as valid block boundaries.
- **Non-finite timestamp guard** — New compression blocks now use finite anchors, and runtime pruning paths validate the raw start/end timestamps they depend on before proceeding.
- **Overlap error diagnostics** — Overlap error messages now include the existing block's timestamp range to aid debugging.
- **Prompt tag name mismatch** — The prompt tag was named `<dcp-message-id>` but the code injected `<dcp-id>`; tag name corrected to `<dcp-id>` throughout `prompts.ts`.
- **Duplicate test** — Removed a duplicate test case from `pruner.test.ts`.

### Added

- **Regression tests** — New test cases for the `Infinity` anchor scenario, `null`-timestamp corrupted blocks, and corrupted-block resilience on session restore.

Thanks to [@wassname](https://github.com/wassname) for diagnosing and fixing the compression spiral root cause in [#3](https://github.com/complexthings/pi-dynamic-context-pruning/pull/3).

## [1.0.6] - 2026-04-09

### Fixed

- **Orphaned tool_use/tool_result after compression** — Compression ranges that touched part of an assistant→toolResult group could leave orphaned `tool_use` or `tool_result` blocks, causing Anthropic API 400 errors (`unexpected tool_use_id found in tool_result blocks`). The backward and forward expansion logic now correctly skips PI-internal passthrough roles (`compaction`, `branch_summary`, `custom_message`) when scanning for paired messages, ensuring atomic removal of complete tool groups.
- **Content mutation across context events** — `applyPruning` now deep-clones message content instead of shallow-copying, preventing injected `dcp-id` blocks from accumulating on shared message objects across successive context events.

### Added

- **Post-compression repair function** — `repairOrphanedToolPairs` runs after all compression blocks are applied as a safety net. It removes orphaned `toolResult`/`bashExecution` messages whose `toolCallId` has no matching `toolCall` in any assistant message, and strips orphaned `toolCall` blocks from assistant messages whose results no longer exist.
- **New test cases** — Tests 5–9 covering passthrough role handling (backward and forward expansion), content mutation isolation, multi-block orphan repair, and direct orphan cleanup.

## [1.0.5] - 2026-04-06

### Fixed

- Prevent orphaned tool_use blocks from compression and harden autocomplete.

## [1.0.4] - 2026-04-05

### Fixed

- Tool crash on compression.

## [1.0.3] - 2026-04-04

### Fixed

- Various errors and issues.

## [1.0.2] - 2026-04-03

### Changed

- Added pi package details to package.json.

## [1.0.1] - 2026-04-02

### Added

- Initial release.
