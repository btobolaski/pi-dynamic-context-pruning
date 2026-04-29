# Dynamic Context Pruning (DCP) for Pi

Automatically reduces token usage in Pi coding agent sessions by managing conversation context through compression, deduplication, and smart nudges.

## Features

- **Compress tool** — LLM-callable tool that replaces stale conversation ranges with exhaustive technical summaries, preserving full context fidelity at a fraction of the token cost
- **Deduplication** — automatically removes duplicate tool call outputs (same tool, same args) keeping only the most recent result
- **Error purging** — cleans up failed tool inputs after a configurable number of user turns
- **Context nudges** — injects compression reminders into the context at configurable thresholds: soft housekeeping notices, strong emergency warnings, and iteration reminders after long tool-call chains
- **Manual mode** — disable autonomous compression nudges; trigger compression only via `/dcp compress` or explicit user request
- **Session persistence** — compression blocks and pruning state survive session restarts
- **`/dcp` commands** — inspect context usage, view stats, sweep tool outputs, and manage compression blocks interactively

## Installation

### Global (applies to all pi sessions)

```bash
pi install npm:@complexthings/pi-dynamic-context-pruning
```

### Install globally from GitHub

```bash
pi install https://github.com/complexthings/pi-dynamic-context-pruning
```

### Try it without installing

```bash
pi -e https://github.com/complexthings/pi-dynamic-context-pruning
```

## Configuration

DCP uses a layered configuration system:

1. Built-in defaults
2. `~/.pi/agent/dcp.jsonc` — global user config (auto-created with a commented default template on first run)
3. `$PI_CONFIG_DIR/dcp.jsonc` — if the env var is set
4. `<project>/.pi/dcp.jsonc` — project-local overrides (walk up from cwd)

Later layers override earlier scalar/object values. Array values are union-merged and deduplicated across layers.

### Example: `~/.pi/agent/dcp.jsonc`

```jsonc
{
  // Disable the extension entirely
  // "enabled": false,

  // Start every session in manual mode
  // "manualMode": { "enabled": true, "automaticStrategies": true },

  "compress": {
    // Above 80 % context: fire a nudge (every nudgeFrequency context events)
    "maxContextPercent": 0.8,
    // Below 40 % context: no nudges
    "minContextPercent": 0.4,
    // Minimum visible conversation items per compress range (0 disables)
    // Raw messages count individually; each active compressed block counts as 1
    "minRangeMessages": 0,
    // How many context events between nudges
    "nudgeFrequency": 5,
    // Nudge after this many tool calls since the last user message
    "iterationNudgeThreshold": 15,
    // "strong" = emergency tone, "soft" = housekeeping tone
    "nudgeForce": "soft",
    // These tool outputs are never auto-pruned
    "protectedTools": ["compress", "write", "edit"],
    // Reserved for future behavior; currently not enforced at runtime
    "protectUserMessages": false
  },
  "strategies": {
    "deduplication": {
      "enabled": true,
      // Additional tools to exclude from dedup
      "protectedTools": []
    },
    "purgeErrors": {
      "enabled": true,
      // Purge failed tool inputs after N user turns
      "turns": 4,
      "protectedTools": []
    }
  },
  // Glob patterns — matching file paths are never pruned
  "protectedFilePatterns": [],
  // "off" | "minimal" | "detailed"
  "pruneNotification": "detailed"
}
```

## Commands

All commands are available in the pi TUI via `/dcp <subcommand>`:

| Command | Description |
|---|---|
| `/dcp` or `/dcp help` | Show command reference |
| `/dcp context` | Show context window usage and session stats |
| `/dcp stats` | Show pruning statistics (tokens saved, blocks, operations) |
| `/dcp sweep [N]` | Mark last N tool outputs for pruning (default: all since last user message) |
| `/dcp manual` | Show current manual mode status |
| `/dcp manual on` | Enable manual mode — autonomous nudges disabled |
| `/dcp manual off` | Disable manual mode — autonomous nudges re-enabled |
| `/dcp compress` | Trigger LLM compression immediately (sends a followUp message) |
| `/dcp decompress` | List all active compression blocks |
| `/dcp decompress N` | Restore compression block `bN` (re-expands it in context) |

## How It Works

### Compression blocks

When the LLM calls the `compress` tool it provides a `topic` string and one or more `{startId, endId, summary}` ranges. DCP:

1. Records the range as a `CompressionBlock` with start/end timestamps
2. On every `context` event, splices out the raw messages in that range
3. Injects a synthetic `[Compressed section: <topic>]` user message containing the summary
4. Appends a `<dcp-block-id>bN</dcp-block-id>` metadata tag to that synthetic message so later compressions can reference the block directly
5. Keeps the block state in the session so it survives restarts

Message IDs (`m001`, `m042`, etc.) and block IDs (`b1`, `b3`) are injected into the visible conversation so the LLM can reference exact boundaries. Active compression blocks cannot be recompressed as part of a new overlapping range unless they are decompressed first. The `compress.protectUserMessages` setting is currently reserved for future behavior and is not enforced yet.

If `compress.minRangeMessages` is set above `0`, each requested range must cover at least that many consecutive **visible** conversation items or the tool rejects the call and asks for a larger range. This count is based on what the model can currently see in context: raw messages count as one item each, and each active compressed block also counts as one visible item.

When compressing a range that already includes compressed blocks, the summary should reference those blocks with `(bN)` placeholders. DCP expands each placeholder with the stored block summary before saving the new compressed section.

### Atomic tool pair removal

When a compression range touches any part of an assistant→toolResult group, DCP automatically expands the range to include the entire group. This prevents orphaned `tool_use` or `tool_result` blocks that would cause API validation errors. The expansion logic skips over PI-internal passthrough messages (`compaction`, `branch_summary`, `custom_message`) that may sit between an assistant and its tool results. A post-compression repair pass acts as a safety net to catch any orphaned pairs that the expansion heuristics miss.

### Nudge types

| Nudge | Condition |
|---|---|
| **context-strong** | Above `maxContextPercent`, nudge counter ≥ `nudgeFrequency`, `nudgeForce = "strong"` |
| **context-soft** | Same as above with `nudgeForce = "soft"` |
| **iteration** | Between min/max percent AND ≥ `iterationNudgeThreshold` tool calls since last user message |
| **turn** | Between min/max percent, standard cadence |

### Deduplication

Two tool results share the same fingerprint (`toolName::JSON(sorted-args)`) if they were called with identical arguments. All but the last occurrence are replaced with a tombstone message.

### Error purging

Tool results that were errors are replaced with a tombstone after `purgeErrors.turns` user turns have passed, keeping the context clean of long-dead failure traces.

## Status indicator

A `DCP` badge is shown in the pi status bar. In manual mode it displays `DCP [manual]`.

## Development

```bash
npm install
npx tsc --noEmit   # type-check without emitting
```

The extension is loaded by pi via [jiti](https://github.com/unjs/jiti) so TypeScript is executed directly — no build step required for normal use.

## Contributors

[![complexthings](https://github.com/complexthings.png?size=50)](https://github.com/complexthings)
[![wassname](https://github.com/wassname.png?size=50)](https://github.com/wassname) 

Full contributor list: https://github.com/complexthings/pi-dynamic-context-pruning/graphs/contributors
