// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) - compress tool registration
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import type { DcpConfig } from "./config.js"
import { COMPRESS_RANGE_DESCRIPTION } from "./prompts.js"
import { estimateTokens, expandCompressionRange } from "./pruner.js"
import { recomputeCompressionTokensSaved } from "./state.js"
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
  summary: string
  containedBlockIds: number[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Determine the anchor timestamp for a compression block - the first visible
 * item that appears strictly after the selected range.
 *
 * Returns `endVisibleTimestamp + 1` when the range extends to the end of the
 * visible conversation. We never use Infinity because it corrupts JSON
 * serialization (becomes null) and breaks numeric comparisons.
 */
function resolveAnchorTimestamp(
  endVisibleTimestamp: number,
  visibleMessages: Array<{ timestamp: number }>,
): number {
  let anchor: number | null = null
  for (const message of visibleMessages) {
    const ts = message.timestamp
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
  visibleMessages: Array<{ timestamp: number }>,
): number {
  const visibleStartTimestamp = resolveIdToVisibleTimestamp(startId, state)
  const visibleEndTimestamp = resolveIdToVisibleTimestamp(endId, state)

  if (visibleStartTimestamp > visibleEndTimestamp) {
    throw new Error(
      `Range start "${startId}" must appear before end "${endId}" in the conversation`,
    )
  }

  return visibleMessages.filter(
    (message) =>
      Number.isFinite(message.timestamp) &&
      message.timestamp >= visibleStartTimestamp &&
      message.timestamp <= visibleEndTimestamp,
  ).length
}

function extractVisibleBlockId(message: any): number | null {
  const parts = Array.isArray(message?.content)
    ? message.content
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
    : typeof message?.content === "string"
      ? message.content
      : ""

  // The genuine block-id metadata is always appended at the very end of the
  // synthetic compressed message (see pruner.ts). Anchor to end-of-string so
  // verbatim summary text cannot spoof a different block id by embedding a
  // <dcp-block-id> tag in the summary body.
  const match = parts.match(/<dcp-block-id>b(\d+)<\/dcp-block-id>\s*$/)
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

function formatBlockIds(blockIds: number[]): string {
  return blockIds.map((id) => `b${id}`).join(", ")
}

/**
 * Parse a single `supersedes` entry into a numeric block ID.
 *
 * Entries must be the canonical `bN` form (no leading zeros, no whitespace,
 * positive integer). Anything else throws a descriptive error so the calling
 * model can correct the input without guessing at the format.
 */
function parseSupersedesEntry(entry: string, startId: string, endId: string): number {
  if (typeof entry !== "string") {
    throw new Error(
      `Roll-up compression range (${startId}..${endId}) has an invalid "supersedes" entry: expected a string like "b3", got ${typeof entry}.`,
    )
  }

  const match = entry.match(/^b([1-9]\d*)$/)
  if (!match) {
    throw new Error(
      `Roll-up compression range (${startId}..${endId}) has an invalid "supersedes" entry "${entry}". ` +
      `Each entry must use the canonical bN form (e.g. "b3"), with no leading zeros or whitespace.`,
    )
  }

  return parseInt(match[1]!, 10)
}

/**
 * Validate the explicit `supersedes` field against the set of active blocks
 * fully contained in the compression range.
 *
 * Supersedes is the model's explicit declaration that a range is a roll-up
 * superseding the listed child blocks. We enforce strict set-equality so the
 * model cannot accidentally orphan or duplicate child blocks.
 *
 * - Non-roll-up range + non-empty supersedes → reject (supersedes refers to
 *   blocks outside the range, or to inactive/unknown blocks).
 * - Roll-up range + missing/duplicated/unexpected entries → reject with a
 *   detailed diff so the model can fix the call on the next attempt.
 * - Roll-up range + omitted supersedes → reject; the model must opt in to
 *   superseding contained children.
 */
function validateSupersedesField(
  supersedes: unknown,
  containedBlockIds: number[],
  startId: string,
  endId: string,
): void {
  if (supersedes !== undefined && !Array.isArray(supersedes)) {
    throw new Error(
      `Compression range (${startId}..${endId}) has an invalid "supersedes" field: expected an array of bN strings, got ${typeof supersedes}.`,
    )
  }

  const expectedIds = [...containedBlockIds].sort((a, b) => a - b)
  const expectedIdSet = new Set(expectedIds)

  const providedIds: number[] = []
  if (supersedes !== undefined) {
    for (const entry of supersedes) {
      providedIds.push(parseSupersedesEntry(entry, startId, endId))
    }
  }

  const providedCounts = new Map<number, number>()
  for (const id of providedIds) {
    providedCounts.set(id, (providedCounts.get(id) ?? 0) + 1)
  }

  const unexpectedIds = [...new Set(providedIds)]
    .filter((id) => !expectedIdSet.has(id))
    .sort((a, b) => a - b)

  if (expectedIds.length === 0) {
    if (providedIds.length > 0) {
      throw new Error(
        `Compression range (${startId}..${endId}) does not fully contain any active compression blocks, ` +
        `so "supersedes" must be omitted or empty. ` +
        `Unexpected entries: ${formatBlockIds(unexpectedIds.length > 0 ? unexpectedIds : [...new Set(providedIds)].sort((a, b) => a - b))}.`,
      )
    }
    return
  }

  if (supersedes === undefined) {
    throw new Error(
      `Roll-up compression range (${startId}..${endId}) fully contains active block(s) ${formatBlockIds(expectedIds)}. ` +
      `Pass "supersedes": [${expectedIds.map((id) => `"b${id}"`).join(", ")}] to acknowledge that those child blocks will be superseded.`,
    )
  }

  const missingIds = expectedIds.filter((id) => (providedCounts.get(id) ?? 0) === 0)
  const duplicatedIds = expectedIds.filter((id) => (providedCounts.get(id) ?? 0) > 1)

  if (missingIds.length > 0 || duplicatedIds.length > 0 || unexpectedIds.length > 0) {
    const parts = [
      `Roll-up compression range (${startId}..${endId}) fully contains active block(s) ${formatBlockIds(expectedIds)}.`,
      `Its "supersedes" array must list each contained block exactly once.`,
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
          supersedes: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Roll-up only: bN ids of active compressed blocks fully contained in this range. " +
                "List each contained block exactly once (e.g. [\"b1\", \"b2\"]). " +
                "Omit (or pass []) when the range contains no active compressed blocks.",
            }),
          ),
        }),
        {
          description: "One or more ranges to compress",
          minItems: 1,
        },
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

      if (params.ranges.length === 0) {
        throw new Error("Compression requests must include at least one range.")
      }

      for (const range of params.ranges) {
        const { startId, endId, summary, supersedes } = range

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
          const visibleItemsInRange = countVisibleItemsInRange(
            startId,
            endId,
            state,
            visibleRangeMessages,
          )
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
        validateSupersedesField(supersedes, containedBlockIds, startId, endId)

        validatedRanges.push({
          startId,
          endId,
          startTimestamp,
          endTimestamp,
          anchorTimestamp: resolveAnchorTimestamp(
            expandedRange.endVisibleTimestamp,
            visibleRangeMessages,
          ),
          summary,
          containedBlockIds,
        })
      }

      for (const range of validatedRanges) {
        const createdAt = Date.now()
        const block: CompressionBlock = {
          id: state.nextBlockId++,
          topic: params.topic,
          summary: range.summary,
          startTimestamp: range.startTimestamp,
          endTimestamp: range.endTimestamp,
          anchorTimestamp: range.anchorTimestamp,
          active: true,
          supersedesBlockIds:
            range.containedBlockIds.length > 0 ? [...range.containedBlockIds] : undefined,
          summaryTokenEstimate: estimateTokens(range.summary),
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

      recomputeCompressionTokensSaved(state)

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
