import type { DcpConfig } from "./config.js";
import { getProtectedTools, resolveToolName } from "./protected-tools.js";
import { markToolPruned } from "./state.js";
import type { DcpState } from "./state.js";

const ID_ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);
// Pi-internal passthrough roles do not get IDs; range expansion may still
// include them when needed to keep assistant/tool-result groups atomic.
const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);

/**
 * Simple token estimator: chars / 4, rounded.
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Estimate tokens from a message's content, whatever shape it takes.
 */
function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;
  const content = msg.content;
  if (!content) return 0;
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") total += estimateTokens(part.text);
        else if (typeof part.thinking === "string") total += estimateTokens(part.thinking);
        else if (part.type === "image") total += 500; // rough estimate for images
      }
    }
    return total;
  }
  return 0;
}

type ExpandableRangeMessage = {
  role: string;
  timestamp: number;
  content?: any;
  toolCallId?: string;
  effectiveStartTimestamp?: number;
  effectiveEndTimestamp?: number;
}

export interface ExpandedCompressionRange {
  startIndex: number;
  endIndex: number;
  startVisibleTimestamp: number;
  endVisibleTimestamp: number;
  startTimestamp: number;
  endTimestamp: number;
}

/**
 * Expand a selected compression range so assistant/tool-result groups stay
 * atomic, returning both the visible bounds and the effective raw bounds.
 */
export function expandCompressionRange(
  messages: ExpandableRangeMessage[],
  startVisibleTimestamp: number,
  endVisibleTimestamp: number,
): ExpandedCompressionRange | null {
  const startIdx = messages.findIndex((m) => m.timestamp === startVisibleTimestamp);
  const endIdx = messages.findIndex((m) => m.timestamp === endVisibleTimestamp);

  if (startIdx === -1 || endIdx === -1) return null;
  if (startIdx > endIdx) return null;

  let lo = startIdx;
  let hi = endIdx;

  while (lo > 0) {
    let scanIdx = lo - 1;
    while (scanIdx >= 0) {
      const role = messages[scanIdx]?.role ?? "";
      if (role !== "toolResult" && role !== "bashExecution" && !PASSTHROUGH_ROLES.has(role)) break;
      scanIdx--;
    }
    if (scanIdx < 0 || messages[scanIdx]?.role !== "assistant") break;

    const toolCallIdsInRange = new Set<string>();
    for (let i = lo; i <= hi; i++) {
      const message = messages[i];
      if (
        (message?.role === "toolResult" || message?.role === "bashExecution") &&
        typeof message.toolCallId === "string"
      ) {
        toolCallIdsInRange.add(message.toolCallId);
      }
    }

    const assistantContent: any[] = Array.isArray(messages[scanIdx]?.content)
      ? messages[scanIdx]!.content
      : [];
    const hasMatchingToolCalls = assistantContent.some(
      (block: any) => block.type === "toolCall" && toolCallIdsInRange.has(block.id),
    );
    if (!hasMatchingToolCalls) break;

    lo = scanIdx;
  }

  let prevHi: number;
  do {
    prevHi = hi;
    const assistantToolCallIds = new Set<string>();

    for (let i = lo; i <= hi; i++) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const content: any[] = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          assistantToolCallIds.add(block.id);
        }
      }
    }

    while (hi + 1 < messages.length) {
      const next = messages[hi + 1];
      if (
        (next?.role === "toolResult" || next?.role === "bashExecution") &&
        assistantToolCallIds.has(next.toolCallId ?? "")
      ) {
        hi++;
      } else if (next && PASSTHROUGH_ROLES.has(next.role)) {
        let scanIdx = hi + 1;
        while (scanIdx < messages.length && PASSTHROUGH_ROLES.has(messages[scanIdx]?.role ?? "")) {
          scanIdx++;
        }
        const bridgedResult = messages[scanIdx];
        if (
          (bridgedResult?.role === "toolResult" || bridgedResult?.role === "bashExecution") &&
          assistantToolCallIds.has(bridgedResult.toolCallId ?? "")
        ) {
          hi++;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  } while (hi !== prevHi);

  let startTimestamp = Infinity;
  let endTimestamp = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const message = messages[i]!;
    const effectiveStart = message.effectiveStartTimestamp ?? message.timestamp;
    const effectiveEnd = message.effectiveEndTimestamp ?? message.timestamp;
    if (effectiveStart < startTimestamp) startTimestamp = effectiveStart;
    if (effectiveEnd > endTimestamp) endTimestamp = effectiveEnd;
  }

  return {
    startIndex: lo,
    endIndex: hi,
    startVisibleTimestamp: messages[lo]!.timestamp,
    endVisibleTimestamp: messages[hi]!.timestamp,
    startTimestamp,
    endTimestamp,
  };
}

/**
 * Apply active compression blocks to the message array.
 * Mutates messages in place (via splice/sort) and returns it.
 */
function applyCompressionBlocks(messages: any[], state: DcpState): any[] {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active);
  if (activeBlocks.length === 0) return messages;

  for (const block of activeBlocks) {
    if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) continue;

    const expandedRange = expandCompressionRange(messages, block.startTimestamp, block.endTimestamp);
    if (!expandedRange) continue;

    let removedTokens = 0;
    for (let i = expandedRange.startIndex; i <= expandedRange.endIndex; i++) {
      removedTokens += estimateMessageTokens(messages[i]);
    }

    messages.splice(expandedRange.startIndex, expandedRange.endIndex - expandedRange.startIndex + 1);

    const syntheticMsg = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "[Compressed section: " +
            block.topic +
            "]\n\n" +
            block.summary +
            "\n\n<dcp-block-id>b" +
            block.id +
            "</dcp-block-id>",
        },
      ],
      timestamp: Number.isFinite(block.anchorTimestamp) ? block.anchorTimestamp - 0.5 : block.endTimestamp + 0.5,
    };

    const addedTokens = estimateMessageTokens(syntheticMsg);

    messages.push(syntheticMsg);
    messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    const saved = removedTokens - addedTokens;
    if (saved > 0 && !block.savingsApplied) {
      state.tokensSaved += saved;
      block.savingsApplied = true;
    }
  }

  return messages;
}

/**
 * Remove orphaned toolResult/bashExecution messages whose corresponding
 * assistant toolCall was removed, and strip orphaned toolCall blocks from
 * assistant messages whose toolResult was removed.
 *
 * This is a safety net that runs after all compression blocks are applied.
 */
function repairOrphanedToolPairs(messages: any[]): void {
  const assistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        assistantToolCallIds.add(block.id);
      }
    }
  }

  const resultToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string") {
      resultToolCallIds.add(msg.toolCallId);
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string" && !assistantToolCallIds.has(msg.toolCallId)) {
      messages.splice(i, 1);
    }
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const hasToolCalls = content.some((b: any) => b.type === "toolCall");
    if (!hasToolCalls) continue;

    const filtered = content.filter((block: any) => {
      if (block.type !== "toolCall") return true;
      return typeof block.id === "string" && resultToolCallIds.has(block.id);
    });

    if (filtered.length !== content.length) {
      msg.content = filtered.length > 0 ? filtered : [];
    }
  }
}

/**
 * Apply deduplication: mark redundant tool outputs for pruning.
 * Mutates state.prunedToolIds.
 */
function applyDeduplication(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.deduplication.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const protectedTools = getProtectedTools(
    config,
    config.strategies.deduplication.protectedTools,
  );

  const fingerprintMap = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;

    const record = state.toolCalls.get(msg.toolCallId);
    const toolName = resolveToolName(record, msg.toolName);
    if (protectedTools.has(toolName)) continue;
    if (!record) continue;

    const fp = record.inputFingerprint;
    if (!fingerprintMap.has(fp)) {
      fingerprintMap.set(fp, []);
    }
    fingerprintMap.get(fp)!.push(msg.toolCallId);
  }

  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      markToolPruned(state, ids[i]!);
    }
  }
}

/**
 * Apply error purging: mark old error tool outputs for pruning.
 * Mutates state.prunedToolIds.
 */
function applyErrorPurging(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.purgeErrors.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const protectedTools = getProtectedTools(
    config,
    config.strategies.purgeErrors.protectedTools,
  );
  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.isError) continue;

    const record = state.toolCalls.get(msg.toolCallId);
    const toolName = resolveToolName(record, msg.toolName);
    if (protectedTools.has(toolName)) continue;
    if (!record) continue;

    if (state.currentTurn - record.turnIndex >= turnsThreshold) {
      markToolPruned(state, msg.toolCallId);
    }
  }
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult messages in place.
 */
function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;

    if (msg.isError) {
      msg.content = [
        {
          type: "text",
          text: "[Error output removed - tool failed more than N turns ago]",
        },
      ];
    } else {
      msg.content = [
        {
          type: "text",
          text: "[Output removed to save context - information superseded or no longer needed]",
        },
      ];
    }
  }
}

/**
 * Inject sequential message IDs into eligible messages.
 * Updates state.messageIdSnapshot.
 */
function injectMessageIds(messages: any[], state: DcpState): void {
  state.messageIdSnapshot.clear();

  let counter = 1;

  for (const msg of messages) {
    const role: string = msg.role ?? "";

    if (PASSTHROUGH_ROLES.has(role)) continue;
    if (!ID_ELIGIBLE_ROLES.has(role)) continue;

    const id = "m" + String(counter).padStart(3, "0");
    counter++;

    const idTag = `\n<dcp-id>${id}</dcp-id>`;

    if (role === "user") {
      if (typeof msg.content === "string") {
        msg.content = msg.content + `\n\n<dcp-id>${id}</dcp-id>`;
      } else if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: idTag }];
      }
    } else if (role === "toolResult" || role === "bashExecution") {
      if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: idTag }];
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + idTag;
      }
    } else if (role === "assistant") {
      if (Array.isArray(msg.content)) {
        // Insert the ID tag before any tool_use (toolCall) blocks.
        // Anthropic requires: thinking → text → tool_use.
        // Appending after tool_use blocks violates that constraint.
        const firstToolCallIdx = msg.content.findIndex(
          (b: any) => b.type === "toolCall",
        );
        const idBlock = { type: "text", text: idTag };
        if (firstToolCallIdx === -1) {
          msg.content = [...msg.content, idBlock];
        } else {
          msg.content = [
            ...msg.content.slice(0, firstToolCallIdx),
            idBlock,
            ...msg.content.slice(firstToolCallIdx),
          ];
        }
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + idTag;
      }
    }

    if (msg.timestamp !== undefined) {
      state.messageIdSnapshot.set(id, msg.timestamp);
    }
  }
}

/**
 * Main transform: applies all pruning and returns modified message array.
 * Called from the `context` event handler.
 */
export function applyPruning(
  messages: any[],
  state: DcpState,
  config: DcpConfig
): any[] {
  // Deep-clone each message and its content to prevent mutations from
  // affecting the original objects across context events.
  const msgs: any[] = messages.map((m: any) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((block: any) =>
        typeof block === "object" && block !== null ? { ...block } : block
      );
    }
    return clone;
  });

  state.currentTurn = msgs.filter((m) => m.role === "user").length;

  applyCompressionBlocks(msgs, state);
  repairOrphanedToolPairs(msgs);
  applyDeduplication(msgs, state, config);
  applyErrorPurging(msgs, state, config);
  applyToolOutputPruning(msgs, state);
  injectMessageIds(msgs, state);

  state.visibleMessagesSnapshot = msgs.map((m: any) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((block: any) =>
        typeof block === "object" && block !== null ? { ...block } : block,
      );
    }
    return clone;
  });

  return msgs;
}

/**
 * Inject a compress nudge as a synthetic user message at the end of messages.
 * Mutates messages in place.
 */
export function injectNudge(messages: any[], nudgeText: string): void {
  messages.push({
    role: "user",
    content: nudgeText,
    timestamp: Date.now(),
  });
}

/**
 * Determine which compress nudge should fire, if any.
 *
 * Above `maxContextPercent`, context-limit nudges fire immediately. Between
 * `minContextPercent` and `maxContextPercent`, turn/iteration nudges fire only
 * once `nudgeCounter` reaches `nudgeFrequency`.
 */
export function getNudgeType(
  contextPercent: number,
  state: DcpState,
  config: DcpConfig,
  toolCallsSinceLastUser: number
): "context-strong" | "context-soft" | "turn" | "iteration" | null {
  const { maxContextPercent, minContextPercent, nudgeFrequency, nudgeForce, iterationNudgeThreshold } =
    config.compress;

  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (contextPercent > minContextPercent && contextPercent <= maxContextPercent) {
    if (state.nudgeCounter < nudgeFrequency) {
      return null;
    }
    if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
      return "iteration";
    }
    return "turn";
  }

  return null;
}
