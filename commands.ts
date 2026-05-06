import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import type { AutocompleteItem } from "@mariozechner/pi-tui"
import { getProtectedTools, resolveToolName } from "./protected-tools.js"
import { markToolPruned, recomputeCompressionTokensSaved } from "./state.js"
import type { DcpState } from "./state.js"
import type { DcpConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString()
}

function formatBlockIdList(blockIds: number[]): string {
  return blockIds.map((id) => `b${id}`).join(", ")
}

function getDirectChildBlocks(state: DcpState, block: DcpState["compressionBlocks"][number]): {
  children: DcpState["compressionBlocks"]
  missingChildIds: number[]
} {
  const childIds = block.supersedesBlockIds ?? []
  const children: DcpState["compressionBlocks"] = []
  const missingChildIds: number[] = []

  for (const id of childIds) {
    const child = state.compressionBlocks.find((candidate) => candidate.id === id)
    if (child) {
      children.push(child)
    } else {
      missingChildIds.push(id)
    }
  }

  return { children, missingChildIds }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP_TEXT = `DCP — Dynamic Context Pruning

Commands:
  /dcp help         — Show command reference
  /dcp context      — Show context window usage breakdown
  /dcp stats        — Show pruning statistics for this session
  /dcp sweep [N]    — Prune last N unprotected tool outputs (default: all unprotected outputs since last user msg)
  /dcp manual       — Show manual mode status
  /dcp manual on    — Enable manual mode (disable autonomous compression)
  /dcp manual off   — Disable manual mode (enable autonomous compression)
  /dcp decompress   — List active and superseded compression blocks
  /dcp decompress N — Decompress block N (reactivates direct children for roll-ups)
  /dcp compress     — Trigger compression (sends a hidden follow-up asking the LLM to use the compress tool)`

function handleHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(HELP_TEXT, "info")
}

// ---------------------------------------------------------------------------
// Context usage
// ---------------------------------------------------------------------------

function handleContext(ctx: ExtensionCommandContext, state: DcpState): void {
  const usage = ctx.getContextUsage()

  const lines: string[] = []

  if (usage) {
    if (usage.tokens !== null) {
      const pct = ((usage.tokens / usage.contextWindow) * 100).toFixed(1)
      lines.push(
        `Context Usage: ${pct}% (${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens)`,
      )
    } else {
      lines.push(`Context Usage: unknown / ${fmt(usage.contextWindow)} tokens`)
    }
  } else {
    lines.push("Context Usage: unavailable")
  }

  lines.push("")
  lines.push("Session Stats:")
  lines.push(`  Tool calls tracked: ${fmt(state.toolCalls.size)}`)
  lines.push(`  Pruned tools: ${fmt(state.prunedToolIds.size)}`)
  lines.push(`  Compression blocks: ${state.compressionBlocks.filter((b) => b.active).length}`)
  lines.push(`  Compression tokens saved (estimated): ${fmt(state.tokensSaved)}`)

  ctx.ui.notify(lines.join("\n"), "info")
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function handleStats(ctx: ExtensionCommandContext, state: DcpState): void {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active).length
  const totalBlocks = state.compressionBlocks.length

  const lines: string[] = []
  lines.push("DCP Session Statistics:")
  lines.push(`  Compression tokens saved (estimated): ${fmt(state.tokensSaved)}`)
  lines.push(`  Total pruning operations: ${fmt(state.totalPruneCount)}`)
  lines.push(`  Compression blocks active: ${activeBlocks} / ${totalBlocks} total`)
  lines.push(`  Manual mode: ${state.manualMode ? "on" : "off"}`)

  ctx.ui.notify(lines.join("\n"), "info")
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function handleSweep(
  ctx: ExtensionCommandContext,
  state: DcpState,
  config: DcpConfig,
  n: number,
): Promise<void> {
  await ctx.waitForIdle()

  const branch = ctx.sessionManager.getBranch()

  const protectedTools = getProtectedTools(
    config,
    config.strategies.deduplication.protectedTools,
  )

  const allToolResults: Array<{ toolCallId: string; toolName: string }> = []
  const toolResultsSinceLastUser: Array<{ toolCallId: string; toolName: string }> = []
  let lastUserMsgBranchIndex = -1

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]
    if (entry.type !== "message") continue
    const msg = (entry as any).message
    if (msg.role === "user") {
      lastUserMsgBranchIndex = i
    }
  }

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]
    if (entry.type !== "message") continue
    const msg = (entry as any).message
    if (msg.role !== "toolResult") continue

    const toolResult = {
      toolCallId: msg.toolCallId as string,
      toolName: typeof msg.toolName === "string" ? msg.toolName : "",
    }
    allToolResults.push(toolResult)

    if (lastUserMsgBranchIndex >= 0 && i > lastUserMsgBranchIndex) {
      toolResultsSinceLastUser.push(toolResult)
    }
  }

  const candidates =
    n > 0
      ? allToolResults
      : lastUserMsgBranchIndex >= 0
        ? toolResultsSinceLastUser
        : allToolResults

  const eligible = candidates.filter(({ toolCallId, toolName }) => {
    if (state.prunedToolIds.has(toolCallId)) return false

    const record = state.toolCalls.get(toolCallId)
    const resolvedToolName = resolveToolName(record, toolName)

    if (resolvedToolName !== "" && protectedTools.has(resolvedToolName)) return false

    return true
  })

  const toAdd = n > 0 ? eligible.slice(-n) : eligible

  for (const { toolCallId } of toAdd) {
    markToolPruned(state, toolCallId)
  }

  const count = toAdd.length
  ctx.ui.notify(`Swept ${count} tool output${count === 1 ? "" : "s"}`, "info")
}

// ---------------------------------------------------------------------------
// Manual mode
// ---------------------------------------------------------------------------

function handleManual(
  ctx: ExtensionCommandContext,
  state: DcpState,
  subArg: string | undefined,
): void {
  if (subArg === "on") {
    state.manualMode = true
    ctx.ui.notify(
      "Manual mode: on\nAutonomous compression is disabled. Use /dcp compress or explicitly ask for compression in chat.",
      "info",
    )
  } else if (subArg === "off") {
    state.manualMode = false
    ctx.ui.notify("Manual mode: off\nAutonomous compression is enabled.", "info")
  } else {
    const status = state.manualMode ? "on" : "off"
    ctx.ui.notify(
      `Manual mode: ${status}\nWhen on: compress tool only fires when you explicitly request it.`,
      "info",
    )
  }
}

// ---------------------------------------------------------------------------
// Decompress
// ---------------------------------------------------------------------------

function handleDecompress(
  ctx: ExtensionCommandContext,
  state: DcpState,
  nArg: string | undefined,
): void {
  if (nArg === undefined) {
    const activeBlocks = state.compressionBlocks.filter((b) => b.active)
    const supersededBlocks = state.compressionBlocks.filter(
      (b) => !b.active && b.supersededByBlockId !== undefined,
    )

    if (activeBlocks.length === 0 && supersededBlocks.length === 0) {
      ctx.ui.notify("No compression blocks.", "info")
      return
    }

    const lines: string[] = []

    if (activeBlocks.length > 0) {
      lines.push("Active compression blocks:")
      for (const block of activeBlocks) {
        const supersedes = block.supersedesBlockIds?.length
          ? ` — supersedes ${formatBlockIdList(block.supersedesBlockIds)}`
          : ""
        lines.push(
          `  b${block.id} — "${block.topic}" (est. ${fmt(block.summaryTokenEstimate)} tokens)${supersedes}`,
        )
      }
    } else {
      lines.push("Active compression blocks: none")
    }

    if (supersededBlocks.length > 0) {
      if (lines.length > 0) lines.push("")
      lines.push("Superseded compression blocks:")
      for (const block of supersededBlocks) {
        lines.push(
          `  b${block.id} — "${block.topic}" (superseded by b${block.supersededByBlockId})`,
        )
      }
    }

    lines.push("")
    lines.push(
      "Run /dcp decompress N to deactivate a block. Decompressing a roll-up parent reactivates its direct child blocks.",
    )

    ctx.ui.notify(lines.join("\n"), "info")
    return
  }

  const id = parseInt(nArg, 10)

  if (isNaN(id)) {
    ctx.ui.notify(
      `Invalid block ID: "${nArg}". Usage: /dcp decompress N`,
      "error",
    )
    return
  }

  const block = state.compressionBlocks.find((b) => b.id === id)

  if (!block) {
    ctx.ui.notify(`No compression block found with id ${id}.`, "error")
    return
  }

  if (!block.active) {
    if (block.supersededByBlockId !== undefined) {
      ctx.ui.notify(
        `Compression block b${id} is currently superseded by b${block.supersededByBlockId}. Decompress b${block.supersededByBlockId} to reactivate it.`,
        "info",
      )
      return
    }

    ctx.ui.notify(`Compression block b${id} is already decompressed.`, "info")
    return
  }

  const { children, missingChildIds } = getDirectChildBlocks(state, block)
  const directChildren = children.sort((a, b) => a.id - b.id)

  if (missingChildIds.length > 0) {
    ctx.ui.notify(
      `Cannot decompress block b${id}: missing direct child block${missingChildIds.length === 1 ? "" : "s"} ${formatBlockIdList(missingChildIds)}.`,
      "error",
    )
    return
  }

  const inconsistentChildren = directChildren.filter(
    (child) => child.active || child.supersededByBlockId !== id,
  )
  if (inconsistentChildren.length > 0) {
    ctx.ui.notify(
      `Cannot decompress block b${id}: child linkage is inconsistent for ${formatBlockIdList(inconsistentChildren.map((child) => child.id))}.`,
      "error",
    )
    return
  }

  block.active = false
  recomputeCompressionTokensSaved(state)

  if (directChildren.length === 0) {
    ctx.ui.notify(`Decompressed block b${id}: "${block.topic}"`, "info")
    return
  }

  for (const child of directChildren) {
    child.active = true
    delete child.supersededByBlockId
    delete child.supersededAt
  }

  recomputeCompressionTokensSaved(state)

  ctx.ui.notify(
    `Decompressed block b${id}: "${block.topic}"\nReactivated direct child block${directChildren.length === 1 ? "" : "s"}: ${formatBlockIdList(directChildren.map((child) => child.id))}`,
    "info",
  )
}

// ---------------------------------------------------------------------------
// Compress (trigger)
// ---------------------------------------------------------------------------

async function handleCompress(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()

  pi.sendMessage(
    {
      customType: "dcp-compress-trigger",
      content:
        "Please compress stale conversation sections using the compress tool now.",
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  )

  ctx.ui.notify("Triggered compression", "info")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerCommands(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
): void {
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning — manage context window usage",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const subcommands: AutocompleteItem[] = [
        { value: "context", label: "context", description: "Show context window usage breakdown" },
        { value: "stats", label: "stats", description: "Show pruning statistics" },
        { value: "sweep", label: "sweep", description: "Prune tool outputs" },
        { value: "manual", label: "manual", description: "Toggle manual mode" },
        { value: "decompress", label: "decompress", description: "List or decompress compression blocks" },
        { value: "compress", label: "compress", description: "Ask the LLM to run compression" },
        { value: "help", label: "help", description: "Show help" },
      ]
      const matched = subcommands
        .filter((s) => typeof s.value === "string")
        .filter((s) => s.value.startsWith(prefix))
      return matched.length > 0 ? matched : null
    },

    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? ""

      switch (sub) {
        case "":
        case "help":
          handleHelp(ctx)
          break

        case "context":
          handleContext(ctx, state)
          break

        case "stats":
          handleStats(ctx, state)
          break

        case "sweep": {
          const rawN = parts[1] !== undefined ? parseInt(parts[1], 10) : 0
          const n = isNaN(rawN) || rawN < 0 ? 0 : rawN
          await handleSweep(ctx, state, config, n)
          break
        }

        case "manual":
          handleManual(ctx, state, parts[1])
          break

        case "decompress":
          handleDecompress(ctx, state, parts[1])
          break

        case "compress":
          await handleCompress(pi, ctx)
          break

        default:
          ctx.ui.notify(
            `Unknown DCP command: "${sub}". Run /dcp help for available commands.`,
            "error",
          )
          break
      }
    },
  })
}
