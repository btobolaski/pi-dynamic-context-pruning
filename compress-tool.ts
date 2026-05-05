// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import type { DcpConfig } from "./config.js"
import { COMPRESS_RANGE_DESCRIPTION } from "./prompts.js"
import { estimateTokens, expandCompressionRange } from "./pruner.js"
import type { CompressionBlock, DcpState } from "./state.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveBlockOverlap = "none" | "contained" | "partial"

type ValidatedRange = {
  startId: string
  endId: string
  startTimestamp: number
  endTimestamp: number
  anchorTimestamp: number
  expandedSummary: string
  containedBlockIds: number[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace `(bN)` placeholders in a summary with the stored content of the
 * referenced compression block. Unrecognised placeholders are left as-is.
 */
function expandBlockPlaceholders(summary: string, state: DcpState): string {
  return summary.replace(/\(b(\d+)\)/g, (match, idStr) => {
    const id = parseInt(idStr, 10)
    const block = state.compressionBlocks.find((b) => b.id === id && b.active)
    return block
      ? `[Previously compressed: ${block.topic}]\n${block.summary}`
      : match
  })
}

/**
 * Resolve a user-supplied ID string (e.g. "m001" or "b3") to an actual
 * message timestamp.
 *
 * - `mNNN` ids → looked up directly in `state.messageIdSnapshot`
 * - `bN` ids   → matched against `state.compressionBlocks` by integer id;
 *                `field` selects whether we return the block's start or end
 *                timestamp depending on whether the id is used as a range
 *                start or end boundary.
 *
 * Throws `Error("Unknown message ID: <id>")` when the id cannot be resolved.
 */
function resolveIdToTimestamp(
  rawId: string,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState,
): number {
  const id = rawId.trim()

  const blockMatch = id.match(/^b(\d+)$/i)
  if (blockMatch) {
    const blockId = parseInt(blockMatch[1]!, 10)
    const block = state.compressionBlocks.find((b) => b.id === blockId && b.active)
    if (!block) throw new Error(`Unknown message ID: ${id}`)
    return block[field]
  }

  const ts = state.messageIdSnapshot.get(id)
  if (ts === undefined) throw new Error(`Unknown message ID: ${id}`)
  return ts
}

/**
 * Determine the anchor timestamp for a compression block — the first visible
 * item that appears strictly after the selected range.
 *
 * Returns `endVisibleTimestamp + 1` when the range extends to the end of the
 * visible conversation. We never use Infinity because it corrupts JSON
 * serialization (becomes null) and breaks numeric comparisons.
 */
function resolveAnchorTimestamp(endVisibleTimestamp: number, state: DcpState): number {
  let anchor: number | null = null
  for (const ts of state.messageIdSnapshot.values()) {
    if (ts > endVisibleTimestamp && (anchor === null || ts < anchor)) {
      anchor = ts
    }
  }
  return anchor ?? endVisibleTimestamp + 1
}

function getVisibleBlockTimestamp(block: CompressionBlock): number {
  return Number.isFinite(block.anchorTimestamp)
    ? block.anchorTimestamp - 0.5
    : block.endTimestamp + 0.5
}

function resolveIdToVisibleTimestamp(rawId: string, state: DcpState): number {
  const id = rawId.trim()

  const blockMatch = id.match(/^b(\d+)$/i)
  if (blockMatch) {
    const blockId = parseInt(blockMatch[1]!, 10)
    const block = state.compressionBlocks.find((b) => b.id === blockId && b.active)
    if (!block) throw new Error(`Unknown message ID: ${id}`)
    return getVisibleBlockTimestamp(block)
  }

  const ts = state.messageIdSnapshot.get(id)
  if (ts === undefined) throw new Error(`Unknown message ID: ${id}`)
  return ts
}

function countVisibleItemsInRange(
  startId: string,
  endId: string,
  state: DcpState,
): number {
  const visibleStartTimestamp = resolveIdToVisibleTimestamp(startId, state)
  const visibleEndTimestamp = resolveIdToVisibleTimestamp(endId, state)

  if (visibleStartTimestamp > visibleEndTimestamp) {
    throw new Error(
      `Range start "${startId}" must appear before end "${endId}" in the conversation`,
    )
  }

  let visibleCount = 0
  for (const timestamp of state.messageIdSnapshot.values()) {
    if (timestamp >= visibleStartTimestamp && timestamp <= visibleEndTimestamp) {
      visibleCount += 1
    }
  }

  return visibleCount
}

function extractVisibleBlockId(message: any): number | null {
  const parts = Array.isArray(message?.content)
    ? message.content
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
    : typeof message?.content === "string"
      ? message.content
      : ""

  const match = parts.match(/<dcp-block-id>b(\d+)<\/dcp-block-id>/)
  return match ? parseInt(match[1]!, 10) : null
}

function buildVisibleRangeMessages(state: DcpState): Array<{
  role: string
  timestamp: number
  content?: unknown
  toolCallId?: string
  effectiveStartTimestamp: number
  effectiveEndTimestamp: number
}> {
  if (state.visibleMessagesSnapshot.length > 0) {
    return state.visibleMessagesSnapshot
      .filter((message: any) => Number.isFinite(message?.timestamp))
      .map((message: any) => {
        const blockId = extractVisibleBlockId(message)
        const block =
          (blockId !== null
            ? state.compressionBlocks.find(
                (candidate) => candidate.active && candidate.id === blockId,
              )
            : undefined) ??
          state.compressionBlocks.find(
            (candidate) =>
              candidate.active && getVisibleBlockTimestamp(candidate) === message.timestamp,
          )

        return {
          role: message.role ?? "user",
          timestamp: message.timestamp,
          content: message.content,
          toolCallId:
            typeof message.toolCallId === "string" ? message.toolCallId : undefined,
          effectiveStartTimestamp: block?.startTimestamp ?? message.timestamp,
          effectiveEndTimestamp: block?.endTimestamp ?? message.timestamp,
        }
      })
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  return [...state.messageIdSnapshot.values()]
    .sort((a, b) => a - b)
    .map((timestamp) => ({
      role: "user",
      timestamp,
      effectiveStartTimestamp: timestamp,
      effectiveEndTimestamp: timestamp,
    }))
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

function rangeContainsBlock(
  startTimestamp: number,
  endTimestamp: number,
  block: CompressionBlock,
): boolean {
  return startTimestamp <= block.startTimestamp && block.endTimestamp <= endTimestamp
}

function classifyActiveBlockOverlap(
  startTimestamp: number,
  endTimestamp: number,
  block: CompressionBlock,
): ActiveBlockOverlap {
  if (!rangesOverlap(startTimestamp, endTimestamp, block.startTimestamp, block.endTimestamp)) {
    return "none"
  }

  if (rangeContainsBlock(startTimestamp, endTimestamp, block)) {
    return "contained"
  }

  return "partial"
}

function extractBlockPlaceholderIds(summary: string): number[] {
  return [...summary.matchAll(/\(b(\d+)\)/g)].map((match) => parseInt(match[1]!, 10))
}

function formatBlockIds(blockIds: number[]): string {
  return blockIds.map((id) => `b${id}`).join(", ")
}

function validateContainedBlockPlaceholders(
  summary: string,
  containedBlockIds: number[],
  startId: string,
  endId: string,
): void {
  const placeholderIds = extractBlockPlaceholderIds(summary)
  const expectedIds = [...containedBlockIds].sort((a, b) => a - b)
  const expectedIdSet = new Set(expectedIds)
  const placeholderCounts = new Map<number, number>()

  for (const id of placeholderIds) {
    placeholderCounts.set(id, (placeholderCounts.get(id) ?? 0) + 1)
  }

  const unexpectedIds = [...new Set(placeholderIds)]
    .filter((id) => !expectedIdSet.has(id))
    .sort((a, b) => a - b)

  if (expectedIds.length === 0) {
    if (unexpectedIds.length > 0) {
      throw new Error(
        `Compression range (${startId}..${endId}) does not contain any active compression blocks, ` +
        `so its summary must not include block placeholders. ` +
        `Unexpected placeholder(s): ${formatBlockIds(unexpectedIds)}.`,
      )
    }
    return
  }

  const missingIds = expectedIds.filter((id) => (placeholderCounts.get(id) ?? 0) === 0)
  const duplicatedIds = expectedIds.filter((id) => (placeholderCounts.get(id) ?? 0) > 1)

  if (missingIds.length > 0 || duplicatedIds.length > 0 || unexpectedIds.length > 0) {
    const parts = [
      `Roll-up compression range (${startId}..${endId}) fully contains active block(s) ${formatBlockIds(expectedIds)}.`,
      `Its summary must reference each contained block exactly once using (bN) placeholders.`,
    ]

    if (missingIds.length > 0) {
      parts.push(`Missing: ${formatBlockIds(missingIds)}.`)
    }
    if (duplicatedIds.length > 0) {
      parts.push(`Duplicated: ${formatBlockIds(duplicatedIds)}.`)
    }
    if (unexpectedIds.length > 0) {
      parts.push(`Unexpected: ${formatBlockIds(unexpectedIds)}.`)
    }

    throw new Error(parts.join(" "))
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/** Register the DCP `compress` tool. */
export function registerCompressTool(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
): void {
  pi.registerTool({
    name: "compress",
    label: "Compress Context",
    description: COMPRESS_RANGE_DESCRIPTION,
    promptSnippet: "Compress ranges of conversation into summaries to manage context",
    parameters: Type.Object({
      topic: Type.String({
        description:
          "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
      }),
      ranges: Type.Array(
        Type.Object({
          startId: Type.String({
            description:
              "Message ID marking start of range (e.g. m001, b2)",
          }),
          endId: Type.String({
            description:
              "Message ID marking end of range (e.g. m042, b5)",
          }),
          summary: Type.String({
            description:
              "Complete technical summary replacing all content in range",
          }),
        }),
        { description: "One or more ranges to compress" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const newBlockIds: number[] = []
      const supersededBlockIds = new Set<number>()
      const minRangeMessages = Number.isFinite(config.compress.minRangeMessages)
        ? Math.max(0, Math.ceil(config.compress.minRangeMessages))
        : 0
      const validatedRanges: ValidatedRange[] = []
      const visibleRangeMessages = buildVisibleRangeMessages(state)

      for (const range of params.ranges) {
        const { startId, endId, summary } = range

        const requestedStartTimestamp = resolveIdToTimestamp(startId, "startTimestamp", state)
        const requestedEndTimestamp = resolveIdToTimestamp(endId, "endTimestamp", state)
        const startVisibleTimestamp = resolveIdToVisibleTimestamp(startId, state)
        const endVisibleTimestamp = resolveIdToVisibleTimestamp(endId, state)

        if (startVisibleTimestamp > endVisibleTimestamp) {
          throw new Error(
            `Range start "${startId}" must appear before end "${endId}" in the conversation`,
          )
        }

        if (!Number.isFinite(requestedStartTimestamp)) {
          throw new Error(
            `Start ID "${startId}" resolved to a non-finite timestamp (${requestedStartTimestamp}). ` +
            `This usually means the referenced message has a corrupted timestamp.`,
          )
        }
        if (!Number.isFinite(requestedEndTimestamp)) {
          throw new Error(
            `End ID "${endId}" resolved to a non-finite timestamp (${requestedEndTimestamp}). ` +
            `This usually means the referenced message has a corrupted timestamp.`,
          )
        }

        if (minRangeMessages > 0) {
          const visibleItemsInRange = countVisibleItemsInRange(startId, endId, state)
          if (visibleItemsInRange < minRangeMessages) {
            throw new Error(
              `Compression range (${startId}..${endId}) covers only ${visibleItemsInRange} visible conversation item(s). ` +
              `This environment requires at least ${minRangeMessages} consecutive visible item(s) per range. ` +
              `Choose a larger consecutive range and try again.`,
            )
          }
        }

        const expandedRange = expandCompressionRange(
          visibleRangeMessages,
          startVisibleTimestamp,
          endVisibleTimestamp,
        )
        if (!expandedRange) {
          throw new Error(
            `Compression range (${startId}..${endId}) could not be resolved against the current visible context. ` +
            `Refresh the visible context and try again.`,
          )
        }

        const { startTimestamp, endTimestamp } = expandedRange

        const containedBlocks = state.compressionBlocks
          .filter((block) => block.active)
          .filter(
            (block) =>
              Number.isFinite(block.startTimestamp) && Number.isFinite(block.endTimestamp),
          )
          .filter((block) => {
            const overlapType = classifyActiveBlockOverlap(startTimestamp, endTimestamp, block)
            if (overlapType === "partial") {
              throw new Error(
                `Overlapping compression ranges are not supported unless the new range fully contains the existing active block for a roll-up. ` +
                `New range (${startId}..${endId}) partially overlaps existing block ` +
                `b${block.id} "${block.topic}" ` +
                `(b${block.id} covers ${block.startTimestamp}..${block.endTimestamp}, ` +
                `new range effectively covers ${startTimestamp}..${endTimestamp}).`,
              )
            }
            return overlapType === "contained"
          })
          .sort(
            (a, b) =>
              a.startTimestamp - b.startTimestamp ||
              a.endTimestamp - b.endTimestamp ||
              a.id - b.id,
          )

        for (const existing of validatedRanges) {
          const overlaps = rangesOverlap(
            startTimestamp,
            endTimestamp,
            existing.startTimestamp,
            existing.endTimestamp,
          )
          if (overlaps) {
            throw new Error(
              `Overlapping compression ranges are not supported. ` +
              `New range (${startId}..${endId}) overlaps another requested range ` +
              `(${existing.startId}..${existing.endId}) after assistant/tool-result atomic expansion.`,
            )
          }
        }

        const containedBlockIds = containedBlocks.map((block) => block.id)
        validateContainedBlockPlaceholders(summary, containedBlockIds, startId, endId)

        validatedRanges.push({
          startId,
          endId,
          startTimestamp,
          endTimestamp,
          anchorTimestamp: resolveAnchorTimestamp(expandedRange.endVisibleTimestamp, state),
          expandedSummary: expandBlockPlaceholders(summary, state),
          containedBlockIds,
        })
      }

      for (const range of validatedRanges) {
        const createdAt = Date.now()
        const block: CompressionBlock = {
          id: state.nextBlockId++,
          topic: params.topic,
          summary: range.expandedSummary,
          startTimestamp: range.startTimestamp,
          endTimestamp: range.endTimestamp,
          anchorTimestamp: range.anchorTimestamp,
          active: true,
          supersedesBlockIds:
            range.containedBlockIds.length > 0 ? [...range.containedBlockIds] : undefined,
          summaryTokenEstimate: estimateTokens(range.expandedSummary),
          createdAt,
        }

        state.compressionBlocks.push(block)
        newBlockIds.push(block.id)

        for (const childId of range.containedBlockIds) {
          const child = state.compressionBlocks.find((candidate) => candidate.id === childId)
          if (!child) continue
          child.active = false
          child.supersededByBlockId = block.id
          child.supersededAt = createdAt
          supersededBlockIds.add(childId)
        }
      }

      if (config.pruneNotification !== "off") {
        const count = params.ranges.length
        const rangeWord = count === 1 ? "range" : "ranges"
        const rollupSuffix =
          supersededBlockIds.size > 0
            ? `, rolled up ${formatBlockIds([...supersededBlockIds].sort((a, b) => a - b))}`
            : ""

        if (config.pruneNotification === "detailed") {
          const totalTokens = newBlockIds.reduce((sum, id) => {
            const b = state.compressionBlocks.find((block) => block.id === id)
            return sum + (b?.summaryTokenEstimate ?? 0)
          }, 0)
          ctx.ui.notify(
            `Compressed: ${params.topic} (${count} ${rangeWord}${rollupSuffix}, ~${totalTokens} tokens in summaries)`,
            "info",
          )
        } else {
          ctx.ui.notify(`Compressed: ${params.topic}`, "info")
        }
      }

      const sortedSupersededBlockIds = [...supersededBlockIds].sort((a, b) => a - b)
      const rollupResultSuffix =
        sortedSupersededBlockIds.length > 0
          ? ` Rolled up ${formatBlockIds(sortedSupersededBlockIds)}; those child blocks are now inactive, so future context shows the new parent block instead of rendering the children separately.`
          : ""

      return {
        content: [
          {
            type: "text",
            text: `Compressed ${params.ranges.length} range(s): ${params.topic}.${rollupResultSuffix}`,
          },
        ],
        details: {
          blockIds: newBlockIds,
          topic: params.topic,
          supersededBlockIds: sortedSupersededBlockIds,
        },
      }
    },
  })
}
