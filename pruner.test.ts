/**
 * Minimal self-contained tests for the applyCompressionBlocks logic inside
 * applyPruning.  No test framework — just assert + console.log.
 *
 * Run with:  bun run pruner.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "assert";
import { registerCommands } from "./commands.js";
import { registerCompressTool } from "./compress-tool.js";
import { loadConfig } from "./config.js";
import {
  COMPRESS_RANGE_DESCRIPTION,
  CONTEXT_LIMIT_NUDGE_SOFT,
  CONTEXT_LIMIT_NUDGE_STRONG,
  ITERATION_NUDGE,
  MANUAL_MODE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  TURN_NUDGE,
} from "./prompts.js";
import { applyPruning, getNudgeType } from "./pruner.js";
import type { DcpState } from "./state.js";
import type { DcpConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

function makeConfig(): DcpConfig {
  return {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: false },
    compress: {
      maxContextPercent: 0.8,
      minContextPercent: 0.4,
      minRangeMessages: 0,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: [],
      protectUserMessages: false,
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
  };
}

function makeState(compressionBlocks: DcpState["compressionBlocks"] = []): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    compressionBlocks,
    nextBlockId: 1,
    visibleMessagesSnapshot: [],
    messageIdSnapshot: new Map(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    manualMode: false,
    nudgeCounter: 0,
    lastNudgeTurn: -1,
  };
}

async function executeCompressTool(
  state: DcpState,
  config: DcpConfig,
  params: { topic: string; ranges: Array<{ startId: string; endId: string; summary: string }> },
  notifications: Array<{ message: string; level: string }> = [],
): Promise<any> {
  let tool: any = null;

  registerCompressTool(
    {
      registerTool(definition: any) {
        tool = definition;
      },
    } as any,
    state,
    config,
  );

  assert.ok(tool, "FAIL — compress tool was not registered");

  return await tool.execute(
    "toolu_test",
    params,
    new AbortController().signal,
    () => {},
    {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  );
}

async function executeDcpCommand(
  state: DcpState,
  config: DcpConfig,
  args: string,
  branch: any[] = [],
): Promise<Array<{ message: string; level: string }>> {
  let command: any = null;
  const notifications: Array<{ message: string; level: string }> = [];

  registerCommands(
    {
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      sendMessage() {},
    } as any,
    state,
    config,
  );

  assert.ok(command, "FAIL — dcp command was not registered");

  await command.handler(args, {
    waitForIdle: async () => {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getBranch() {
        return branch;
      },
    },
  } as any);

  return notifications;
}

function assertIncludesAll(text: string, expected: string[], label: string): void {
  for (const phrase of expected) {
    assert.ok(text.includes(phrase), `FAIL — ${label} should include: ${phrase}`);
  }
}

// Four-message sequence that exercises the bug:
//   user(1000) → assistant+toolCall(2000) → toolResult(3000) → user(4000)
function makeMessages(): any[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "please read the file" }],
      timestamp: 1000,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_abc", name: "read", arguments: {} }],
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_abc",
      toolName: "read",
      content: [{ type: "text", text: "file content" }],
      isError: false,
      timestamp: 3000,
    },
    {
      role: "user",
      content: [{ type: "text", text: "thanks" }],
      timestamp: 4000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper: find the first orphaned tool_use in a result array
//
// An assistant message is "orphaned" if it contains a toolCall block whose
// id does NOT have a matching toolResult as the very next message.
// ---------------------------------------------------------------------------
function findOrphanedToolUse(result: any[]): string | null {
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;

    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolCallBlocks = content.filter((b: any) => b.type === "toolCall");
    if (toolCallBlocks.length === 0) continue;

    for (const tc of toolCallBlocks) {
      const next = result[i + 1];
      const nextIsMatchingResult =
        next &&
        next.role === "toolResult" &&
        next.toolCallId === tc.id;

      if (!nextIsMatchingResult) {
        return (
          `assistant at index ${i} (ts=${msg.timestamp}) has toolCall id="${tc.id}" ` +
          `but next message is: ${next ? `role="${next.role}" toolCallId="${next.toolCallId}"` : "<nothing>"}`
        );
      }
    }
  }
  return null; // no orphan found
}

// ---------------------------------------------------------------------------
// Test 1 — BUG SCENARIO
//
// Compression block covers ONLY the toolResult (startTimestamp=3000,
// endTimestamp=3000).  Without the backward-expansion fix, the assistant
// message with the toolCall block survives but its toolResult is gone →
// orphaned tool_use.  With the fix the assistant is pulled into the range
// and both messages are removed together.
// ---------------------------------------------------------------------------
{
  console.log("TEST 1: compression block covers only the toolResult (bug scenario)");

  const messages = makeMessages();
  const state = makeState([
    {
      id: 1,
      topic: "file read",
      summary: "The file was read and contained some data.",
      startTimestamp: 3000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 15,
      createdAt: Date.now(),
    },
  ]);
  const config = makeConfig();

  const result = applyPruning(messages, state, config);

  console.log("  Result messages (role, timestamp):");
  for (const m of result) {
    const ts = m.timestamp;
    const preview =
      typeof m.content === "string"
        ? m.content.slice(0, 60)
        : Array.isArray(m.content)
        ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
        : "?";
    console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
  }

  // 1a. No orphaned tool_use
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(
    orphan,
    null,
    `FAIL — orphaned tool_use detected: ${orphan}`
  );
  console.log("  PASS: no orphaned tool_use in result");

  // 1b. The assistant message at ts=2000 must NOT survive without its partner
  const assistantInResult = result.find(
    (m) => m.role === "assistant" && m.timestamp === 2000
  );
  if (assistantInResult) {
    // If it survived, its immediate successor must be the matching toolResult
    const idx = result.indexOf(assistantInResult);
    const successor = result[idx + 1];
    assert.ok(
      successor && successor.role === "toolResult" && successor.toolCallId === "toolu_abc",
      `FAIL — assistant(ts=2000) survived but successor is not the matching toolResult ` +
        `(got role="${successor?.role}" toolCallId="${successor?.toolCallId}")`
    );
    console.log("  PASS: assistant survived with its toolResult partner intact");
  } else {
    // The preferred outcome: both removed together
    const toolResultInResult = result.find(
      (m) => m.role === "toolResult" && m.toolCallId === "toolu_abc"
    );
    assert.strictEqual(
      toolResultInResult,
      undefined,
      "FAIL — assistant removed but orphaned toolResult still present"
    );
    console.log("  PASS: both assistant and toolResult removed together");
  }

  console.log("TEST 1 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 2 — PASSING SCENARIO
//
// Compression block covers BOTH the assistant and the toolResult
// (startTimestamp=2000, endTimestamp=3000).  Both messages must be removed
// and no orphaned tool_use must remain.
// ---------------------------------------------------------------------------
{
  console.log("TEST 2: compression block covers both assistant and toolResult (passing scenario)");

  const messages = makeMessages();
  const state = makeState([
    {
      id: 1,
      topic: "file read",
      summary: "The file was read and contained some data.",
      startTimestamp: 2000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 15,
      createdAt: Date.now(),
    },
  ]);
  const config = makeConfig();

  const result = applyPruning(messages, state, config);

  console.log("  Result messages (role, timestamp):");
  for (const m of result) {
    const ts = m.timestamp;
    const preview =
      typeof m.content === "string"
        ? m.content.slice(0, 60)
        : Array.isArray(m.content)
        ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
        : "?";
    console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
  }

  // 2a. No orphaned tool_use
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(
    orphan,
    null,
    `FAIL — orphaned tool_use detected: ${orphan}`
  );
  console.log("  PASS: no orphaned tool_use in result");

  // 2b. The assistant at ts=2000 must be absent from the result
  const assistantInResult = result.find(
    (m) => m.role === "assistant" && m.timestamp === 2000
  );
  assert.strictEqual(
    assistantInResult,
    undefined,
    `FAIL — assistant(ts=2000) should have been removed but is still present`
  );
  console.log("  PASS: assistant(ts=2000) removed");

  // 2c. The toolResult must also be absent
  const toolResultInResult = result.find(
    (m) => m.role === "toolResult" && m.toolCallId === "toolu_abc"
  );
  assert.strictEqual(
    toolResultInResult,
    undefined,
    `FAIL — toolResult(toolCallId="toolu_abc") should have been removed but is still present`
  );
  console.log("  PASS: toolResult(toolu_abc) removed");

  // 2d. A synthetic summary message should be present
  const synthetic = result.find(
    (m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("Compressed section")
  );
  assert.ok(
    synthetic,
    "FAIL — expected a synthetic [Compressed section] user message in result"
  );
  console.log("  PASS: synthetic summary message present");

  console.log("TEST 2 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 3 — MULTI-TOOLRESULT BACKWARD GAP
//
// assistant has TWO tool_calls (A + B) producing two consecutive toolResult
// messages.  The compression range starts at toolResult_B — meaning there is
// a toolResult message (A) sitting between lo and the assistant.
//
// Bug: backward expansion stopped at toolResult_A (not an assistant) and
// never found the assistant → assistant was kept without its toolResult_B.
// Fix: backward scan skips past toolResult messages to reach the assistant.
//
// Sequence:
//   user(1000) → assistant(2000, toolCall_A + toolCall_B)
//              → toolResult_A(3000) → toolResult_B(4000) → user(5000)
// Compression block: [4000..4000] (only toolResult_B)
// Expected: assistant + toolResult_A + toolResult_B all removed together
// ---------------------------------------------------------------------------
{
  console.log("TEST 3: multi-toolResult backward gap (assistant has 2 tool_calls)");

  const messages: any[] = [
    { role: "user",        content: [{ type: "text", text: "do two things" }], timestamp: 1000 },
    { role: "assistant",   content: [
        { type: "toolCall", id: "toolu_A", name: "read",  arguments: {} },
        { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
      ], timestamp: 2000 },
    { role: "toolResult",  toolCallId: "toolu_A", toolName: "read",  isError: false, content: [{ type: "text", text: "A result" }], timestamp: 3000 },
    { role: "toolResult",  toolCallId: "toolu_B", toolName: "write", isError: false, content: [{ type: "text", text: "B result" }], timestamp: 4000 },
    { role: "user",        content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "two-tool work",
      summary: "Both tools were called successfully.",
      startTimestamp: 4000,  // only toolResult_B
      endTimestamp:   4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // Neither the orphaned assistant nor its toolResults should survive unpaired
  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultAPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
  const toolResultBPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");

  // All three must be absent (removed atomically) or all three present as a valid group
  if (assistantPresent) {
    assert.ok(toolResultAPresent, "FAIL — assistant present but toolResult_A missing");
    assert.ok(toolResultBPresent, "FAIL — assistant present but toolResult_B missing");
    // Verify ordering: assistant → toolResult_A → toolResult_B
    const aIdx = result.findIndex((m: any) => m.role === "assistant" && m.timestamp === 2000);
    const rAIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
    const rBIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
    assert.ok(aIdx < rAIdx && rAIdx < rBIdx, "FAIL — assistant + toolResult ordering wrong");
    console.log("  PASS: assistant + both toolResults kept as a coherent group");
  } else {
    assert.ok(!toolResultAPresent, "FAIL — assistant removed but orphaned toolResult_A still present");
    assert.ok(!toolResultBPresent, "FAIL — assistant removed but orphaned toolResult_B still present");
    console.log("  PASS: assistant + both toolResults removed atomically");
  }

  console.log("TEST 3 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 4 — BASHEXECUTION FORWARD GAP
//
// An assistant calls a tool whose result is stored as role="bashExecution".
// The compression range covers the assistant but NOT the bashExecution result.
//
// Bug (before fix): forward expansion only checked role==="toolResult", so
// bashExecution was left behind as an orphan.
// Fix: forward expansion now also advances hi over bashExecution messages.
//
// Sequence:
//   user(1000) → assistant(2000, toolCall_bash) → bashExecution(3000) → user(4000)
// Compression block: [2000..2000] (only the assistant)
// Expected: assistant + bashExecution removed together
// ---------------------------------------------------------------------------
{
  console.log("TEST 4: bashExecution forward gap");

  const messages: any[] = [
    { role: "user",          content: [{ type: "text", text: "run bash" }], timestamp: 1000 },
    { role: "assistant",     content: [{ type: "toolCall", id: "toolu_bash1", name: "bash", arguments: {} }], timestamp: 2000 },
    { role: "bashExecution", toolCallId: "toolu_bash1", toolName: "bash", isError: false, content: [{ type: "text", text: "exit 0" }], timestamp: 3000 },
    { role: "user",          content: [{ type: "text", text: "done" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "bash run",
      summary: "Ran bash command successfully.",
      startTimestamp: 2000,
      endTimestamp:   2000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 8,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const assistantPresent   = result.some((m: any) => m.role === "assistant"     && m.timestamp === 2000);
  const bashPresent        = result.some((m: any) => m.role === "bashExecution" && m.toolCallId === "toolu_bash1");

  if (assistantPresent) {
    assert.ok(bashPresent, "FAIL — assistant present but bashExecution result missing");
    console.log("  PASS: assistant + bashExecution kept as a coherent group");
  } else {
    assert.ok(!bashPresent, "FAIL — assistant removed but orphaned bashExecution still present");
    console.log("  PASS: assistant + bashExecution removed atomically");
  }

  console.log("TEST 4 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 5 — PASSTHROUGH ROLE BETWEEN ASSISTANT AND TOOLRESULT (BACKWARD)
//
// A `compaction` message sits between the assistant and the toolResult.
// The compression range covers only the toolResult.  Backward expansion
// must skip the compaction to find the assistant and include it atomically.
//
// Sequence:
//   user(1000) → assistant(2000, toolCall_X) → compaction(2500)
//              → toolResult_X(3000) → user(4000)
// Compression block: [3000..3000]
// Expected: assistant + toolResult removed together (no orphans)
// ---------------------------------------------------------------------------
{
  console.log("TEST 5: passthrough role between assistant and toolResult (backward expansion)");

  const messages: any[] = [
    { role: "user",        content: [{ type: "text", text: "read file" }], timestamp: 1000 },
    { role: "assistant",   content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }], timestamp: 2000 },
    { role: "compaction",  content: [{ type: "text", text: "compaction summary" }], timestamp: 2500 },
    { role: "toolResult",  toolCallId: "toolu_X", toolName: "read", isError: false, content: [{ type: "text", text: "file data" }], timestamp: 3000 },
    { role: "user",        content: [{ type: "text", text: "thanks" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "file read",
      summary: "File was read successfully.",
      startTimestamp: 3000,
      endTimestamp:   3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_X");
  assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
  assert.ok(!toolResultPresent, "FAIL — toolResult should have been removed");
  console.log("  PASS: assistant + toolResult removed atomically despite compaction in between");

  console.log("TEST 5 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 6 — PASSTHROUGH ROLE BETWEEN TOOLRESULTS (FORWARD EXPANSION)
//
// An assistant has two tool calls.  A `branch_summary` message sits between
// the two toolResults.  The compression range covers the assistant.
// Forward expansion must skip the branch_summary to find both toolResults.
//
// Sequence:
//   user(1000) → assistant(2000, toolCall_A + toolCall_B)
//              → toolResult_A(3000) → branch_summary(3500)
//              → toolResult_B(4000) → user(5000)
// Compression block: [2000..2000]
// Expected: assistant + both toolResults removed together (no orphans)
// ---------------------------------------------------------------------------
{
  console.log("TEST 6: passthrough role between toolResults (forward expansion)");

  const messages: any[] = [
    { role: "user",           content: [{ type: "text", text: "do things" }], timestamp: 1000 },
    { role: "assistant",      content: [
        { type: "toolCall", id: "toolu_A", name: "read",  arguments: {} },
        { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
      ], timestamp: 2000 },
    { role: "toolResult",     toolCallId: "toolu_A", toolName: "read",  isError: false, content: [{ type: "text", text: "A result" }], timestamp: 3000 },
    { role: "branch_summary", content: [{ type: "text", text: "branch summary" }], timestamp: 3500 },
    { role: "toolResult",     toolCallId: "toolu_B", toolName: "write", isError: false, content: [{ type: "text", text: "B result" }], timestamp: 4000 },
    { role: "user",           content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "two tools",
      summary: "Both tools were called.",
      startTimestamp: 2000,
      endTimestamp:   2000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultAPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
  const toolResultBPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
  assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
  assert.ok(!toolResultAPresent, "FAIL — toolResult_A should have been removed");
  assert.ok(!toolResultBPresent, "FAIL — toolResult_B should have been removed");
  console.log("  PASS: assistant + both toolResults removed despite branch_summary in between");

  console.log("TEST 6 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7 — CONTENT MUTATION ISOLATION
//
// Verifies that applyPruning does not mutate the original message objects.
// After calling applyPruning, the original messages' content arrays should
// remain unchanged (no injected dcp-id blocks).
// ---------------------------------------------------------------------------
{
  console.log("TEST 7: content mutation isolation");

  const messages = makeMessages();
  // Deep-snapshot the original content for comparison
  const originalContents = messages.map((m: any) =>
    JSON.stringify(m.content)
  );

  const state = makeState(); // no compression blocks
  const config = makeConfig();

  // Run applyPruning — this should NOT mutate the originals
  applyPruning(messages, state, config);

  let mutated = false;
  for (let i = 0; i < messages.length; i++) {
    const current = JSON.stringify(messages[i].content);
    if (current !== originalContents[i]) {
      console.log(`  FAIL — message[${i}] content was mutated`);
      console.log(`    before: ${originalContents[i]}`);
      console.log(`    after:  ${current}`);
      mutated = true;
    }
  }

  assert.ok(!mutated, "FAIL — original message content was mutated by applyPruning");
  console.log("  PASS: original message content unchanged after applyPruning");

  console.log("TEST 7 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 8 — ORPHANED TOOLRESULT REPAIR
//
// Two compression blocks where the second removes an assistant but forward
// expansion cannot reach its toolResult due to processing order.  The repair
// function should clean up the orphan.
//
// Sequence:
//   user(1000) → assistant_1(2000, toolCall_X) → toolResult_X(3000) →
//   user(4000) → assistant_2(5000, toolCall_Y) → toolResult_Y(6000) → user(7000)
//
// Block 1: [1000..3000] — removes user, assistant_1, toolResult_X
// Block 2: [4000..5000] — removes user, assistant_2 (toolResult_Y is outside)
//   Forward expansion from assistant_2 should catch toolResult_Y, but if it
//   doesn't (edge case), repair must clean it up.
// ---------------------------------------------------------------------------
{
  console.log("TEST 8: orphaned toolResult repair (post-compression safety net)");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "first" }], timestamp: 1000 },
    { role: "assistant",  content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }], timestamp: 2000 },
    { role: "toolResult", toolCallId: "toolu_X", toolName: "read", isError: false, content: [{ type: "text", text: "X data" }], timestamp: 3000 },
    { role: "user",       content: [{ type: "text", text: "second" }], timestamp: 4000 },
    { role: "assistant",  content: [{ type: "toolCall", id: "toolu_Y", name: "write", arguments: {} }], timestamp: 5000 },
    { role: "toolResult", toolCallId: "toolu_Y", toolName: "write", isError: false, content: [{ type: "text", text: "Y data" }], timestamp: 6000 },
    { role: "user",       content: [{ type: "text", text: "done" }], timestamp: 7000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "block one",
      summary: "First block compressed.",
      startTimestamp: 1000,
      endTimestamp:   3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "block two",
      summary: "Second block compressed.",
      startTimestamp: 4000,
      endTimestamp:   5000,
      anchorTimestamp: 7000,
      active: true,
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // No orphaned tool_use or tool_result should remain
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);

  const orphanedResults = result.filter(
    (m: any) => (m.role === "toolResult" || m.role === "bashExecution") &&
    !result.some((a: any) =>
      a.role === "assistant" &&
      Array.isArray(a.content) &&
      a.content.some((b: any) => b.type === "toolCall" && b.id === m.toolCallId)
    )
  );
  assert.strictEqual(orphanedResults.length, 0, `FAIL — ${orphanedResults.length} orphaned toolResult(s) found`);
  console.log("  PASS: no orphaned tool_use or toolResult in result");

  console.log("TEST 8 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 9 — DIRECT ORPHAN REPAIR (pre-broken state)
//
// Directly construct a message array with an orphaned toolResult (no matching
// assistant toolCall exists).  The repair function should remove it.
// ---------------------------------------------------------------------------
{
  console.log("TEST 9: direct orphan repair (pre-broken toolResult)");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    { role: "toolResult", toolCallId: "orphan_id", toolName: "read", isError: false, content: [{ type: "text", text: "orphan data" }], timestamp: 2000 },
    { role: "user",       content: [{ type: "text", text: "bye" }], timestamp: 3000 },
  ];

  const state = makeState(); // no compression blocks — repair runs as safety net
  const config = makeConfig();

  const result = applyPruning(messages, state, config);

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphanPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "orphan_id");
  assert.ok(!orphanPresent, "FAIL — orphaned toolResult should have been removed by repair");
  console.log("  PASS: orphaned toolResult removed by repair function");

  console.log("TEST 9 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 10 — CORRUPTED BLOCK WITH NULL/INFINITY TIMESTAMPS (resilience)
//
// Blocks from older sessions may have null/Infinity timestamps due to JSON
// round-trip corruption. These blocks should be skipped during compression
// application and should not block new compress operations.
// ---------------------------------------------------------------------------
{
  console.log("TEST 10: corrupted block with null/Infinity timestamps is skipped");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    { role: "assistant",  content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    { role: "user",       content: [{ type: "text", text: "bye" }], timestamp: 3000 },
  ];

  // Block with corrupted timestamps (null from JSON round-trip)
  const state = makeState([
    {
      id: 1,
      topic: "ghost block",
      summary: "This block has corrupted timestamps.",
      startTimestamp: null as any,  // null from JSON deserialization of Infinity
      endTimestamp: null as any,
      anchorTimestamp: null as any,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // All 3 original messages should survive (ghost block was skipped)
  assert.strictEqual(result.length, 3, `FAIL — expected 3 messages, got ${result.length}`);
  console.log("  PASS: corrupted block skipped, all original messages preserved");

  console.log("TEST 10 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 11 — MIN RANGE DISABLED BY DEFAULT
// ---------------------------------------------------------------------------
{
  console.log("TEST 11: minRangeMessages=0 leaves small ranges allowed");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);

  const result = await executeCompressTool(state, makeConfig(), {
    topic: "tiny range",
    ranges: [
      {
        startId: "m001",
        endId: "m001",
        summary: "Single-message compression remains allowed when disabled.",
      },
    ],
  });

  assert.deepStrictEqual(result.details.blockIds, [1], "FAIL — expected block id b1");
  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL — expected one compression block");
  console.log("  PASS: single-message range accepted when validation is disabled");

  console.log("TEST 11 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 12 — MIN RANGE REJECTION
// ---------------------------------------------------------------------------
{
  console.log("TEST 12: compress rejects ranges smaller than minRangeMessages");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);
  state.messageIdSnapshot.set("m003", 3000);
  state.messageIdSnapshot.set("m004", 4000);

  const config = makeConfig();
  config.compress.minRangeMessages = 3;

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "too small",
        ranges: [
          {
            startId: "m002",
            endId: "m003",
            summary: "This range is only two visible items long.",
          },
        ],
      }),
    /covers only 2 visible conversation item\(s\).*requires at least 3 consecutive visible item\(s\).*Choose a larger consecutive range and try again\./s,
    "FAIL — expected a minimum-range validation error",
  );
  assert.strictEqual(
    state.compressionBlocks.length,
    0,
    "FAIL — rejected compression should not create a block",
  );
  console.log("  PASS: too-small range rejected with clear guidance");

  console.log("TEST 12 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 13 — MIN RANGE ACCEPTANCE AT THRESHOLD
// ---------------------------------------------------------------------------
{
  console.log("TEST 13: compress accepts ranges that meet minRangeMessages exactly");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);
  state.messageIdSnapshot.set("m003", 3000);
  state.messageIdSnapshot.set("m004", 4000);

  const config = makeConfig();
  config.compress.minRangeMessages = 3;

  const result = await executeCompressTool(state, config, {
    topic: "large enough",
    ranges: [
      {
        startId: "m002",
        endId: "m004",
        summary: "This range covers three visible items and should succeed.",
      },
    ],
  });

  assert.deepStrictEqual(result.details.blockIds, [1], "FAIL — expected block id b1");
  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL — expected one compression block");
  assert.strictEqual(
    state.compressionBlocks[0]?.startTimestamp,
    2000,
    "FAIL — expected the block to start at m002",
  );
  assert.strictEqual(
    state.compressionBlocks[0]?.endTimestamp,
    4000,
    "FAIL — expected the block to end at m004",
  );
  console.log("  PASS: threshold-sized range accepted");

  console.log("TEST 13 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 14 — BATCHED VALIDATION IS ATOMIC
// ---------------------------------------------------------------------------
{
  console.log("TEST 14: batched compress rejection does not partially create blocks");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);
  state.messageIdSnapshot.set("m003", 3000);
  state.messageIdSnapshot.set("m004", 4000);
  state.messageIdSnapshot.set("m005", 5000);

  const config = makeConfig();
  config.compress.minRangeMessages = 3;

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "mixed batch",
        ranges: [
          {
            startId: "m001",
            endId: "m003",
            summary: "This range is valid.",
          },
          {
            startId: "m004",
            endId: "m005",
            summary: "This range is too small.",
          },
        ],
      }),
    /requires at least 3 consecutive visible item\(s\)/,
    "FAIL — expected the mixed batch to be rejected",
  );
  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL — rejected batch should create no blocks");
  assert.strictEqual(state.nextBlockId, 1, "FAIL — rejected batch should not advance nextBlockId");
  console.log("  PASS: rejected batch leaves compression state unchanged");

  console.log("TEST 14 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 15 — CONFIG LOADING DEFAULTS AND LAYER PRECEDENCE
// ---------------------------------------------------------------------------
{
  console.log("TEST 15: loadConfig auto-creates ~/.pi/agent/dcp.jsonc and honors layer precedence");

  const previousHome = process.env["HOME"];
  const previousPiConfigDir = process.env["PI_CONFIG_DIR"];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-config-test-"));
  const homeDir = path.join(tempRoot, "home");
  const envDir = path.join(tempRoot, "env");
  const projectDir = path.join(tempRoot, "project");
  const nestedProjectDir = path.join(projectDir, "src", "nested");
  const globalConfigPath = path.join(homeDir, ".pi", "agent", "dcp.jsonc");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(nestedProjectDir, { recursive: true });

  try {
    process.env["HOME"] = homeDir;
    delete process.env["PI_CONFIG_DIR"];

    const defaultConfig = loadConfig(projectDir);
    assert.strictEqual(
      defaultConfig.compress.minRangeMessages,
      0,
      "FAIL — minRangeMessages should default to 0",
    );
    assert.ok(
      fs.existsSync(globalConfigPath),
      "FAIL — global config should be auto-created at ~/.pi/agent/dcp.jsonc",
    );

    fs.writeFileSync(
      globalConfigPath,
      `{
  "compress": {
    "minRangeMessages": 1
  }
}
`,
      "utf8",
    );

    const globalConfig = loadConfig(projectDir);
    assert.strictEqual(
      globalConfig.compress.minRangeMessages,
      1,
      "FAIL — global config should override the default value",
    );

    process.env["PI_CONFIG_DIR"] = envDir;
    fs.writeFileSync(
      path.join(envDir, "dcp.jsonc"),
      `{
  "compress": {
    "minRangeMessages": 2
  }
}
`,
      "utf8",
    );

    const envConfig = loadConfig(projectDir);
    assert.strictEqual(
      envConfig.compress.minRangeMessages,
      2,
      "FAIL — PI_CONFIG_DIR config should override the global config",
    );

    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "dcp.jsonc"),
      `{
  "compress": {
    "minRangeMessages": 3
  }
}
`,
      "utf8",
    );

    const projectConfig = loadConfig(nestedProjectDir);
    assert.strictEqual(
      projectConfig.compress.minRangeMessages,
      3,
      "FAIL — project config should override env/global config when discovered from nested directories",
    );
    assert.strictEqual(
      projectConfig.strategies.purgeErrors.turns,
      4,
      "FAIL — unrelated default values should remain intact after layered merges",
    );
    console.log("  PASS: config loading preserves defaults, merges all layers, and walks up for project config");
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;

    if (previousPiConfigDir === undefined) delete process.env["PI_CONFIG_DIR"];
    else process.env["PI_CONFIG_DIR"] = previousPiConfigDir;

    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("TEST 15 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 16 — CONFIG PARSE ERRORS, ARRAY MERGING, AND LEGACY PATH REGRESSION
// ---------------------------------------------------------------------------
{
  console.log("TEST 16: loadConfig ignores malformed files, union-merges arrays, and ignores the legacy global path");

  const previousHome = process.env["HOME"];
  const previousPiConfigDir = process.env["PI_CONFIG_DIR"];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-config-regression-test-"));
  const homeDir = path.join(tempRoot, "home");
  const envDir = path.join(tempRoot, "env");
  const projectDir = path.join(tempRoot, "project");
  const newGlobalConfigPath = path.join(homeDir, ".pi", "agent", "dcp.jsonc");
  const legacyGlobalConfigPath = path.join(homeDir, ".config", "pi", "dcp.jsonc");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.mkdirSync(path.dirname(newGlobalConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(legacyGlobalConfigPath), { recursive: true });

  try {
    process.env["HOME"] = homeDir;
    process.env["PI_CONFIG_DIR"] = envDir;

    fs.writeFileSync(
      legacyGlobalConfigPath,
      `{
  "compress": {
    "minRangeMessages": 99
  }
}
`,
      "utf8",
    );
    fs.writeFileSync(
      newGlobalConfigPath,
      `{
  "compress": {
    "minRangeMessages": 1,
    "protectedTools": ["write"]
  }
}
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(envDir, "dcp.jsonc"),
      `{
  "compress": {
    "protectedTools": ["read"]
  }
}
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, ".pi", "dcp.jsonc"),
      `{
  "compress": {
    "protectedTools": ["write", "edit"]
  }
}
`,
      "utf8",
    );

    const mergedConfig = loadConfig(projectDir);
    assert.strictEqual(
      mergedConfig.compress.minRangeMessages,
      1,
      "FAIL — legacy ~/.config/pi/dcp.jsonc should be ignored in favor of ~/.pi/agent/dcp.jsonc",
    );
    assert.deepStrictEqual(
      mergedConfig.compress.protectedTools,
      ["compress", "write", "edit", "read"],
      "FAIL — protectedTools should be union-merged and deduplicated across config layers",
    );

    fs.writeFileSync(
      path.join(envDir, "dcp.jsonc"),
      `{
  "compress": {
    "protectedTools": ["read"]
`,
      "utf8",
    );

    const malformedEnvConfig = loadConfig(projectDir);
    assert.deepStrictEqual(
      malformedEnvConfig.compress.protectedTools,
      ["compress", "write", "edit"],
      "FAIL — malformed env config should be ignored instead of partially applied",
    );
    console.log("  PASS: malformed configs are ignored, arrays union-merge, and the legacy path is unused");
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;

    if (previousPiConfigDir === undefined) delete process.env["PI_CONFIG_DIR"];
    else process.env["PI_CONFIG_DIR"] = previousPiConfigDir;

    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("TEST 16 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 17 — LEGACY-ONLY PATH IS IGNORED AND DEFAULTS ARE ISOLATED
// ---------------------------------------------------------------------------
{
  console.log("TEST 17: loadConfig ignores the legacy-only path and returns isolated default objects");

  const previousHome = process.env["HOME"];
  const previousPiConfigDir = process.env["PI_CONFIG_DIR"];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-config-isolation-test-"));
  const homeDir = path.join(tempRoot, "home");
  const projectDir = path.join(tempRoot, "project");
  const newGlobalConfigPath = path.join(homeDir, ".pi", "agent", "dcp.jsonc");
  const legacyGlobalConfigPath = path.join(homeDir, ".config", "pi", "dcp.jsonc");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacyGlobalConfigPath), { recursive: true });

  try {
    process.env["HOME"] = homeDir;
    delete process.env["PI_CONFIG_DIR"];

    fs.writeFileSync(
      legacyGlobalConfigPath,
      `{
  "compress": {
    "minRangeMessages": 99
  }
}
`,
      "utf8",
    );

    const configA = loadConfig(projectDir);
    const configB = loadConfig(projectDir);

    assert.ok(
      fs.existsSync(newGlobalConfigPath),
      "FAIL — loading config should create the new ~/.pi/agent/dcp.jsonc template even when only the legacy path exists",
    );
    assert.strictEqual(
      configA.compress.minRangeMessages,
      0,
      "FAIL — legacy-only ~/.config/pi/dcp.jsonc should be ignored",
    );
    assert.notStrictEqual(
      configA.compress,
      configB.compress,
      "FAIL — separate loadConfig calls should not share nested config objects",
    );

    configA.compress.protectedTools.push("grep");
    assert.deepStrictEqual(
      configB.compress.protectedTools,
      ["compress", "write", "edit"],
      "FAIL — mutating one loaded config should not affect another or DEFAULT_CONFIG",
    );
    console.log("  PASS: legacy-only path is ignored and returned configs do not share nested defaults");
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;

    if (previousPiConfigDir === undefined) delete process.env["PI_CONFIG_DIR"];
    else process.env["PI_CONFIG_DIR"] = previousPiConfigDir;

    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("TEST 17 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 18 — Mid-band nudges are cadence-gated
// ---------------------------------------------------------------------------
{
  console.log("TEST 18: mid-band nudges wait for nudgeFrequency");

  const config = makeConfig();
  config.compress.minContextPercent = 0.5;
  config.compress.maxContextPercent = 0.8;
  config.compress.nudgeFrequency = 20;
  config.compress.iterationNudgeThreshold = 40;

  const beforeCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 19 }, config, 0);
  assert.strictEqual(
    beforeCadence,
    null,
    "FAIL — mid-band nudges should not fire before nudgeFrequency is reached",
  );

  const atCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 0);
  assert.strictEqual(
    atCadence,
    "turn",
    "FAIL — mid-band nudges should fire once nudgeFrequency is reached",
  );

  const strongMidBand = getNudgeType(
    0.6,
    { ...makeState(), nudgeCounter: 20 },
    { ...config, compress: { ...config.compress, nudgeForce: "strong" } },
    0,
  );
  assert.strictEqual(
    strongMidBand,
    "turn",
    "FAIL — nudgeForce=strong should not change mid-band turn nudges into context nudges",
  );

  const iterationBeforeCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 19 }, config, 40);
  assert.strictEqual(
    iterationBeforeCadence,
    null,
    "FAIL — mid-band iteration nudges should not fire before nudgeFrequency is reached",
  );

  const iterationAtCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 40);
  assert.strictEqual(
    iterationAtCadence,
    "iteration",
    "FAIL — mid-band iteration nudges should fire once cadence and iteration thresholds are both reached",
  );

  const belowIterationThreshold = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 39);
  assert.strictEqual(
    belowIterationThreshold,
    "turn",
    "FAIL — mid-band nudges should remain turn nudges until iteration threshold is reached",
  );

  console.log("  PASS: mid-band nudges are cadence-gated");
  console.log("TEST 18 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 19 — Above-max nudges fire immediately
// ---------------------------------------------------------------------------
{
  console.log("TEST 19: above-max context nudges fire immediately");

  const softConfig = makeConfig();
  softConfig.compress.maxContextPercent = 0.8;
  softConfig.compress.nudgeFrequency = 20;
  softConfig.compress.nudgeForce = "soft";

  const softNudge = getNudgeType(0.81, { ...makeState(), nudgeCounter: 0 }, softConfig, 0);
  assert.strictEqual(
    softNudge,
    "context-soft",
    "FAIL — above-max context should trigger a soft nudge immediately regardless of cadence",
  );

  const strongConfig = makeConfig();
  strongConfig.compress.maxContextPercent = 0.8;
  strongConfig.compress.nudgeFrequency = 20;
  strongConfig.compress.nudgeForce = "strong";

  const strongNudge = getNudgeType(0.95, { ...makeState(), nudgeCounter: 0 }, strongConfig, 0);
  assert.strictEqual(
    strongNudge,
    "context-strong",
    "FAIL — above-max context should trigger a strong nudge immediately regardless of cadence",
  );

  const aboveMaxWithManyTools = getNudgeType(0.95, { ...makeState(), nudgeCounter: 0 }, softConfig, 40);
  assert.strictEqual(
    aboveMaxWithManyTools,
    "context-soft",
    "FAIL — above-max context nudges should take precedence over iteration nudges",
  );

  const state = makeState();
  const firstAboveMax = getNudgeType(0.9, state, softConfig, 0);
  assert.strictEqual(
    firstAboveMax,
    "context-soft",
    "FAIL — above-max context should trigger on the first eligible context event",
  );
  state.nudgeCounter = 0;
  const secondAboveMax = getNudgeType(0.9, state, softConfig, 0);
  assert.strictEqual(
    secondAboveMax,
    "context-soft",
    "FAIL — above-max context should trigger again immediately after the counter reset",
  );

  console.log("  PASS: above-max nudges ignore cadence and fire immediately");
  console.log("TEST 19 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 20 — Threshold boundaries
// ---------------------------------------------------------------------------
{
  console.log("TEST 20: nudge threshold boundaries");

  const config = makeConfig();
  config.compress.minContextPercent = 0.5;
  config.compress.maxContextPercent = 0.8;
  config.compress.nudgeFrequency = 20;
  config.compress.nudgeForce = "soft";
  config.compress.iterationNudgeThreshold = 40;

  assert.strictEqual(
    getNudgeType(0.5, { ...makeState(), nudgeCounter: 999 }, config, 999),
    null,
    "FAIL — exactly minContextPercent should not trigger a nudge",
  );

  assert.strictEqual(
    getNudgeType(0.5001, { ...makeState(), nudgeCounter: 19 }, config, 999),
    null,
    "FAIL — just above minContextPercent should still respect cadence",
  );

  assert.strictEqual(
    getNudgeType(0.8, { ...makeState(), nudgeCounter: 19 }, config, 0),
    null,
    "FAIL — exactly maxContextPercent should remain cadence-gated",
  );

  assert.strictEqual(
    getNudgeType(0.8, { ...makeState(), nudgeCounter: 20 }, config, 0),
    "turn",
    "FAIL — exactly maxContextPercent should use mid-band turn behavior at cadence",
  );

  assert.strictEqual(
    getNudgeType(0.8001, { ...makeState(), nudgeCounter: 0 }, config, 999),
    "context-soft",
    "FAIL — values above maxContextPercent should immediately trigger context nudges",
  );

  console.log("  PASS: threshold boundaries behave as expected");
  console.log("TEST 20 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 21 — ROLL-UP COMPRESSION CREATES A PARENT BLOCK
// ---------------------------------------------------------------------------
{
  console.log("TEST 21: roll-up compression supersedes child blocks and prunes to the parent");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "gamma" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "delta" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "epsilon" }], timestamp: 5000 },
    { role: "user", content: [{ type: "text", text: "zeta" }], timestamp: 6000 },
    { role: "user", content: [{ type: "text", text: "omega" }], timestamp: 7000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first slice",
      summary: "First slice summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second slice",
      summary: "Second slice summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "third slice",
      summary: "Third slice summary.",
      startTimestamp: 5000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 4;

  const config = makeConfig();
  config.pruneNotification = "detailed";

  const preRollupVisible = applyPruning(messages, state, config);
  const preRollupCompressedCount = preRollupVisible.filter(
    (m: any) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      typeof m.content[0]?.text === "string" &&
      m.content[0].text.startsWith("[Compressed section:"),
  ).length;
  assert.strictEqual(
    preRollupCompressedCount,
    3,
    "FAIL — expected three visible child compressed sections before the roll-up",
  );

  const notifications: Array<{ message: string; level: string }> = [];
  const result = await executeCompressTool(
    state,
    config,
    {
      topic: "rolled up slices",
      ranges: [
        {
          startId: "b1",
          endId: "b3",
          summary:
            "Combined closed work:\n\n(b1)\n\nThen the next resolved section concluded.\n\n(b2)\n\nFinally the last closed section completed.\n\n(b3)",
        },
      ],
    },
    notifications,
  );

  assert.deepStrictEqual(result.details.blockIds, [4], "FAIL — expected parent block id b4");
  assert.deepStrictEqual(
    result.details.supersededBlockIds,
    [1, 2, 3],
    "FAIL — expected the roll-up result to report superseded child blocks",
  );
  const resultText = result.content?.[0]?.text ?? "";
  assert.ok(
    resultText.includes("Rolled up b1, b2, b3"),
    "FAIL — expected roll-up result text to report superseded child blocks",
  );
  assert.ok(
    resultText.includes("future context shows the new parent block"),
    "FAIL — expected roll-up result text to explain future parent-only rendering",
  );
  assert.ok(
    notifications[0]?.message.includes("rolled up b1, b2, b3"),
    "FAIL — expected detailed notification to report rolled-up child blocks",
  );

  const parent = state.compressionBlocks.find((b) => b.id === 4);
  const parentSummary = parent?.summary ?? "";
  assert.ok(parent, "FAIL — expected the roll-up parent block to exist");
  assert.strictEqual(parent?.active, true, "FAIL — expected the parent block to be active");
  assert.deepStrictEqual(
    parent?.supersedesBlockIds,
    [1, 2, 3],
    "FAIL — expected the parent block to record its child block IDs",
  );
  assert.ok(
    parentSummary.includes("First slice summary.") &&
      parentSummary.includes("Second slice summary.") &&
      parentSummary.includes("Third slice summary."),
    "FAIL — expected the stored parent summary to include expanded child summaries",
  );
  assert.ok(
    !parentSummary.includes("(b1)") && !parentSummary.includes("(b2)") && !parentSummary.includes("(b3)"),
    "FAIL — expected roll-up placeholders to be expanded before storage",
  );

  for (const childId of [1, 2, 3]) {
    const child = state.compressionBlocks.find((b) => b.id === childId);
    assert.strictEqual(child?.active, false, `FAIL — expected child block b${childId} to be inactive`);
    assert.strictEqual(
      child?.supersededByBlockId,
      4,
      `FAIL — expected child block b${childId} to point at parent b4`,
    );
  }

  const postRollupVisible = applyPruning(messages, state, config);
  const visibleCompressedSections = postRollupVisible.filter(
    (m: any) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      typeof m.content[0]?.text === "string" &&
      m.content[0].text.startsWith("[Compressed section:"),
  );
  assert.strictEqual(
    visibleCompressedSections.length,
    1,
    "FAIL — expected only the parent compressed section to remain visible after roll-up",
  );
  assert.ok(
    visibleCompressedSections[0].content[0].text.includes("<dcp-block-id>b4</dcp-block-id>"),
    "FAIL — expected the visible compressed section to be the new parent block",
  );
  assert.strictEqual(parent?.anchorTimestamp, 7000, "FAIL — expected the parent block to anchor on the first visible item after the roll-up range");
  for (const ts of [1000, 2000, 3000, 4000, 5000, 6000]) {
    assert.ok(
      !postRollupVisible.some((m: any) => m.timestamp === ts),
      `FAIL — raw message ts=${ts} should be removed by the roll-up parent`,
    );
  }
  assert.ok(
    postRollupVisible.some((m: any) => m.timestamp === 7000),
    "FAIL — expected the raw message after the roll-up range to remain visible",
  );
  const postRollupText = JSON.stringify(postRollupVisible);
  assert.ok(!postRollupText.includes("b1</dcp-block-id>"), "FAIL — child block b1 should not remain visible");
  assert.ok(!postRollupText.includes("b2</dcp-block-id>"), "FAIL — child block b2 should not remain visible");
  assert.ok(!postRollupText.includes("b3</dcp-block-id>"), "FAIL — child block b3 should not remain visible");

  console.log("  PASS: roll-up created a parent block, anchored correctly, and only the parent remains visible");
  console.log("TEST 21 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 22 — PARTIAL OVERLAP IS REJECTED ATOMICALLY
// ---------------------------------------------------------------------------
{
  console.log("TEST 22: partial overlap with an active block is rejected");

  const state = makeState([
    {
      id: 1,
      topic: "existing block",
      summary: "Existing summary.",
      startTimestamp: 2000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 2;
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);
  state.messageIdSnapshot.set("m003", 3000);
  state.messageIdSnapshot.set("m004", 4000);

  await assert.rejects(
    () =>
      executeCompressTool(state, makeConfig(), {
        topic: "partial overlap",
        ranges: [
          {
            startId: "m001",
            endId: "m002",
            summary: "This should be rejected because it only overlaps part of b1.",
          },
        ],
      }),
    /partially overlaps existing block b1/,
    "FAIL — expected partial overlap validation to reject the range",
  );

  assert.strictEqual(
    state.compressionBlocks.length,
    1,
    "FAIL — rejected partial overlap should not create a new compression block",
  );
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL — existing block should remain active");
  assert.strictEqual(state.nextBlockId, 2, "FAIL — rejected partial overlap should not advance nextBlockId");

  console.log("  PASS: partial overlap rejected without mutating state");
  console.log("TEST 22 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 23 — ROLL-UP PLACEHOLDERS ARE STRICTLY VALIDATED
// ---------------------------------------------------------------------------
{
  console.log("TEST 23: roll-up compression requires each contained placeholder exactly once");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "gamma" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "delta" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "omega" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first slice",
      summary: "First slice summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second slice",
      summary: "Second slice summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "bad roll-up",
        ranges: [
          {
            startId: "b1",
            endId: "b2",
            summary: "Repeated child:\n\n(b1)\n\nAgain:\n\n(b1)",
          },
        ],
      }),
    /Missing: b2\..*Duplicated: b1\./s,
    "FAIL — expected strict placeholder validation to reject the malformed roll-up summary",
  );

  assert.strictEqual(
    state.compressionBlocks.length,
    2,
    "FAIL — rejected roll-up should not create a parent block",
  );
  assert.strictEqual(state.nextBlockId, 3, "FAIL — rejected roll-up should not advance nextBlockId");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL — child b1 should remain active");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL — child b2 should remain active");

  console.log("  PASS: malformed roll-up placeholders rejected without mutating state");
  console.log("TEST 23 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 24 — DECOMPRESSING A ROLL-UP REACTIVATES DIRECT CHILDREN
// ---------------------------------------------------------------------------
{
  console.log("TEST 24: /dcp decompress shows supersession and reactivates direct children");

  const state = makeState([
    {
      id: 1,
      topic: "first child",
      summary: "First child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: false,
      supersededByBlockId: 3,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second child",
      summary: "Second child summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: false,
      supersededByBlockId: 3,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "parent roll-up",
      summary: "Parent summary.",
      startTimestamp: 1000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      supersedesBlockIds: [1, 2],
      summaryTokenEstimate: 8,
      createdAt: Date.now(),
    },
  ]);

  const listNotifications = await executeDcpCommand(state, makeConfig(), "decompress");
  assert.ok(listNotifications[0]?.message.includes("Active compression blocks:"), "FAIL — expected the block listing to show the active section");
  assert.ok(listNotifications[0]?.message.includes("Superseded compression blocks:"), "FAIL — expected the block listing to show the superseded section");
  assert.ok(listNotifications[0]?.message.includes("supersedes b1, b2"), "FAIL — expected the active parent to describe its child blocks");

  const decompressNotifications = await executeDcpCommand(state, makeConfig(), "decompress 3");

  assert.strictEqual(state.compressionBlocks[2]?.active, false, "FAIL — expected the parent block to be deactivated");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL — expected child b1 to reactivate");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL — expected child b2 to reactivate");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, undefined, "FAIL — expected child b1 to clear supersededByBlockId");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, undefined, "FAIL — expected child b2 to clear supersededByBlockId");
  assert.ok(
    decompressNotifications[0]?.message.includes("Reactivated direct child blocks: b1, b2"),
    "FAIL — expected parent decompression to report reactivated child blocks",
  );

  console.log("  PASS: /dcp decompress restored the direct child blocks of a roll-up parent");
  console.log("TEST 24 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 25 — EFFECTIVE-RANGE OVERLAP IS REJECTED IN BATCHES
// ---------------------------------------------------------------------------
{
  console.log("TEST 25: batched ranges that overlap after atomic expansion are rejected");

  const messages = makeMessages();
  const state = makeState();
  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "effective overlap",
        ranges: [
          {
            startId: "m003",
            endId: "m003",
            summary: "Compress the tool result only.",
          },
          {
            startId: "m002",
            endId: "m002",
            summary: "Compress the assistant only.",
          },
        ],
      }),
    /after assistant\/tool-result atomic expansion/,
    "FAIL — expected effective-range overlap validation to reject the batch",
  );

  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL — rejected effective-overlap batch should create no blocks");
  assert.strictEqual(state.nextBlockId, 1, "FAIL — rejected effective-overlap batch should not advance nextBlockId");

  console.log("  PASS: effective-range overlap is rejected before any block is created");
  console.log("TEST 25 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 26 — UNEXPECTED PLACEHOLDERS ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 26: roll-up rejects unexpected placeholders outside the selected range");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "gamma" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "delta" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "omega" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "inside",
      summary: "Inside summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "outside",
      summary: "Outside summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "bad placeholders",
        ranges: [
          {
            startId: "b1",
            endId: "b1",
            summary: "Selected child:\n\n(b1)\n\nUnexpected extra child:\n\n(b2)",
          },
        ],
      }),
    /Unexpected: b2\./,
    "FAIL — expected an unexpected-placeholder validation error",
  );

  assert.strictEqual(state.compressionBlocks.length, 2, "FAIL — rejected placeholder validation should not create a new block");
  assert.strictEqual(state.nextBlockId, 3, "FAIL — rejected placeholder validation should not advance nextBlockId");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL — block b1 should remain active");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL — block b2 should remain active");

  console.log("  PASS: unexpected placeholders are rejected without mutating state");
  console.log("TEST 26 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 27 — ROLL-UP BATCH VALIDATION IS ATOMIC
// ---------------------------------------------------------------------------
{
  console.log("TEST 27: mixed roll-up batch rejection does not create or supersede blocks");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "e" }], timestamp: 5000 },
    { role: "user", content: [{ type: "text", text: "f" }], timestamp: 6000 },
    { role: "user", content: [{ type: "text", text: "g" }], timestamp: 7000 },
    { role: "user", content: [{ type: "text", text: "h" }], timestamp: 8000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 9000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "one",
      summary: "One summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "two",
      summary: "Two summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "three",
      summary: "Three summary.",
      startTimestamp: 5000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 4,
      topic: "four",
      summary: "Four summary.",
      startTimestamp: 7000,
      endTimestamp: 8000,
      anchorTimestamp: 9000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 5;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "mixed roll-up batch",
        ranges: [
          {
            startId: "b1",
            endId: "b2",
            summary: "Valid roll-up:\n\n(b1)\n\nThen\n\n(b2)",
          },
          {
            startId: "b3",
            endId: "b4",
            summary: "Invalid roll-up:\n\n(b3)",
          },
        ],
      }),
    /Missing: b4\./,
    "FAIL — expected the invalid roll-up in the batch to reject the whole batch",
  );

  assert.strictEqual(state.compressionBlocks.length, 4, "FAIL — rejected roll-up batch should not create parent blocks");
  assert.strictEqual(state.nextBlockId, 5, "FAIL — rejected roll-up batch should not advance nextBlockId");
  for (const childId of [1, 2, 3, 4]) {
    const child = state.compressionBlocks.find((b) => b.id === childId);
    assert.strictEqual(child?.active, true, `FAIL — child block b${childId} should remain active after batch rejection`);
    assert.strictEqual(child?.supersededByBlockId, undefined, `FAIL — child block b${childId} should not be superseded after batch rejection`);
  }

  console.log("  PASS: roll-up batch validation remains atomic");
  console.log("TEST 27 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 28 — NESTED DECOMPRESSION REACTIVATES ONLY DIRECT CHILDREN
// ---------------------------------------------------------------------------
{
  console.log("TEST 28: nested decompression reactivates only direct child blocks");

  const state = makeState([
    {
      id: 1,
      topic: "grandchild one",
      summary: "Grandchild one.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: false,
      supersededByBlockId: 3,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "grandchild two",
      summary: "Grandchild two.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: false,
      supersededByBlockId: 3,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "child roll-up",
      summary: "Child roll-up.",
      startTimestamp: 1000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: false,
      supersedesBlockIds: [1, 2],
      supersededByBlockId: 5,
      supersededAt: Date.now(),
      summaryTokenEstimate: 8,
      createdAt: Date.now(),
    },
    {
      id: 4,
      topic: "sibling child",
      summary: "Sibling child.",
      startTimestamp: 5000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: false,
      supersededByBlockId: 5,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 5,
      topic: "top roll-up",
      summary: "Top roll-up.",
      startTimestamp: 1000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: true,
      supersedesBlockIds: [3, 4],
      summaryTokenEstimate: 10,
      createdAt: Date.now(),
    },
  ]);

  const notifications = await executeDcpCommand(state, makeConfig(), "decompress 5");

  assert.strictEqual(state.compressionBlocks[4]?.active, false, "FAIL — expected the top parent to deactivate");
  assert.strictEqual(state.compressionBlocks[2]?.active, true, "FAIL — expected direct child b3 to reactivate");
  assert.strictEqual(state.compressionBlocks[3]?.active, true, "FAIL — expected direct child b4 to reactivate");
  assert.strictEqual(state.compressionBlocks[0]?.active, false, "FAIL — grandchild b1 should remain inactive under b3");
  assert.strictEqual(state.compressionBlocks[1]?.active, false, "FAIL — grandchild b2 should remain inactive under b3");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, 3, "FAIL — grandchild b1 should remain superseded by b3");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, 3, "FAIL — grandchild b2 should remain superseded by b3");
  assert.ok(
    notifications[0]?.message.includes("Reactivated direct child blocks: b3, b4"),
    "FAIL — expected nested decompression to report only direct child reactivation",
  );

  console.log("  PASS: nested decompression restores only the direct children of the parent block");
  console.log("TEST 28 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 29 — REVERSED VISIBLE BOUNDARIES ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 29: reversed visible boundaries are rejected even when minRangeMessages is disabled");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "gamma" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "delta" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first slice",
      summary: "First slice summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second slice",
      summary: "Second slice summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "reversed",
        ranges: [
          {
            startId: "b2",
            endId: "b1",
            summary: "This should be rejected before any roll-up work happens.",
          },
        ],
      }),
    /must appear before end/,
    "FAIL — expected reversed visible boundaries to be rejected",
  );

  assert.strictEqual(state.compressionBlocks.length, 2, "FAIL — reversed range should not create a new block");
  assert.strictEqual(state.nextBlockId, 3, "FAIL — reversed range should not advance nextBlockId");

  console.log("  PASS: reversed visible boundaries are rejected under the default config");
  console.log("TEST 29 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 30 — NON-ROLL-UP PLACEHOLDERS ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 30: non-roll-up ranges cannot include block placeholders");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);

  await assert.rejects(
    () =>
      executeCompressTool(state, makeConfig(), {
        topic: "bad non-roll-up placeholder",
        ranges: [
          {
            startId: "m001",
            endId: "m002",
            summary: "This raw range must not mention (b1).",
          },
        ],
      }),
    /does not contain any active compression blocks.*must not include block placeholders/s,
    "FAIL — expected non-roll-up placeholder usage to be rejected",
  );

  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL — rejected non-roll-up placeholder should not create a block");
  assert.strictEqual(state.nextBlockId, 1, "FAIL — rejected non-roll-up placeholder should not advance nextBlockId");

  console.log("  PASS: raw-only ranges reject block placeholders");
  console.log("TEST 30 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 31 — DECOMPRESSION FAILS ATOMICALLY WHEN A CHILD IS MISSING
// ---------------------------------------------------------------------------
{
  console.log("TEST 31: parent decompression fails atomically when a direct child is missing");

  const state = makeState([
    {
      id: 1,
      topic: "present child",
      summary: "Present child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: false,
      supersededByBlockId: 3,
      supersededAt: Date.now(),
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "parent roll-up",
      summary: "Parent summary.",
      startTimestamp: 1000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      supersedesBlockIds: [1, 2],
      summaryTokenEstimate: 8,
      createdAt: Date.now(),
    },
  ]);

  const notifications = await executeDcpCommand(state, makeConfig(), "decompress 3");

  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL — parent should remain active when a child is missing");
  assert.strictEqual(state.compressionBlocks[0]?.active, false, "FAIL — existing child should remain inactive when decompression fails");
  assert.strictEqual(notifications[0]?.level, "error", "FAIL — expected a missing-child decompression error");
  assert.ok(
    notifications[0]?.message.includes("missing direct child block b2"),
    "FAIL — expected the missing child to be reported",
  );

  console.log("  PASS: missing-child decompression leaves hierarchy unchanged");
  console.log("TEST 31 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 32 — BN RANGES PARTICIPATE IN EFFECTIVE OVERLAP CHECKS
// ---------------------------------------------------------------------------
{
  console.log("TEST 32: bN-based ranges are rejected when they overlap after atomic expansion");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_bn", name: "read", arguments: {} }],
      timestamp: 3000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_bn",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: 4000,
    },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "earlier block",
      summary: "Earlier summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 2;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "b-range overlap",
        ranges: [
          {
            startId: "b1",
            endId: "m003",
            summary: "Roll up earlier work:\n\n(b1)\n\nThen include the tool-result span.",
          },
          {
            startId: "m002",
            endId: "m002",
            summary: "Compress only the assistant boundary.",
          },
        ],
      }),
    /after assistant\/tool-result atomic expansion/,
    "FAIL — expected a bN-based effective overlap rejection",
  );

  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL — rejected bN overlap should not create new blocks");
  assert.strictEqual(state.nextBlockId, 2, "FAIL — rejected bN overlap should not advance nextBlockId");

  console.log("  PASS: bN ranges use the same effective overlap model as raw message ranges");
  console.log("TEST 32 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 33 — NESTED ROLL-UPS WORK END-TO-END
// ---------------------------------------------------------------------------
{
  console.log("TEST 33: nested roll-ups can be created end-to-end and restore visible children on decompression");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "e" }], timestamp: 5000 },
    { role: "user", content: [{ type: "text", text: "f" }], timestamp: 6000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 7000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first leaf",
      summary: "First leaf summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second leaf",
      summary: "Second leaf summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 5000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "third leaf",
      summary: "Third leaf summary.",
      startTimestamp: 5000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 4;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "child roll-up",
    ranges: [
      {
        startId: "b1",
        endId: "b2",
        summary: "Child parent:\n\n(b1)\n\nThen\n\n(b2)",
      },
    ],
  });

  const childParent = state.compressionBlocks.find((b) => b.id === 4);
  assert.ok(childParent?.active, "FAIL — expected the first nested parent to be active");
  assert.deepStrictEqual(childParent?.supersedesBlockIds, [1, 2], "FAIL — expected b4 to supersede b1 and b2");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, 4, "FAIL — expected b1 to point at b4");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, 4, "FAIL — expected b2 to point at b4");

  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "top roll-up",
    ranges: [
      {
        startId: "b4",
        endId: "b3",
        summary: "Top parent:\n\n(b4)\n\nThen\n\n(b3)",
      },
    ],
  });

  const topParent = state.compressionBlocks.find((b) => b.id === 5);
  assert.ok(topParent?.active, "FAIL — expected the top nested parent to be active");
  assert.deepStrictEqual(topParent?.supersedesBlockIds, [4, 3], "FAIL — expected b5 to supersede b4 and b3");
  assert.strictEqual(state.compressionBlocks[2]?.supersededByBlockId, 5, "FAIL — expected b3 to point at b5");
  assert.strictEqual(state.compressionBlocks[3]?.supersededByBlockId, 5, "FAIL — expected b4 to point at b5");

  const topVisible = applyPruning(messages, state, config);
  const topVisibleText = JSON.stringify(topVisible);
  assert.ok(topVisibleText.includes("b5</dcp-block-id>"), "FAIL — expected b5 to be visible after the top roll-up");
  assert.ok(!topVisibleText.includes("b4</dcp-block-id>"), "FAIL — b4 should be hidden under the top parent");
  assert.ok(!topVisibleText.includes("b3</dcp-block-id>"), "FAIL — b3 should be hidden under the top parent");
  assert.ok(!topVisibleText.includes("b1</dcp-block-id>"), "FAIL — b1 should remain hidden under b4");
  assert.ok(!topVisibleText.includes("b2</dcp-block-id>"), "FAIL — b2 should remain hidden under b4");

  await executeDcpCommand(state, config, "decompress 5");
  const decompressedVisible = applyPruning(messages, state, config);
  const decompressedText = JSON.stringify(decompressedVisible);
  assert.ok(!decompressedText.includes("b5</dcp-block-id>"), "FAIL — b5 should disappear after decompression");
  assert.ok(decompressedText.includes("b4</dcp-block-id>"), "FAIL — b4 should become visible after decompressing b5");
  assert.ok(decompressedText.includes("b3</dcp-block-id>"), "FAIL — b3 should become visible after decompressing b5");
  assert.ok(!decompressedText.includes("b1</dcp-block-id>"), "FAIL — b1 should stay hidden under active b4");
  assert.ok(!decompressedText.includes("b2</dcp-block-id>"), "FAIL — b2 should stay hidden under active b4");

  console.log("  PASS: nested roll-ups create the correct hierarchy and restore only direct visible children on decompression");
  console.log("TEST 33 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 34 — DECOMPRESSION FAILS ATOMICALLY WHEN CHILD LINKAGE IS INCONSISTENT
// ---------------------------------------------------------------------------
{
  console.log("TEST 34: parent decompression fails atomically when child linkage is inconsistent");

  const state = makeState([
    {
      id: 1,
      topic: "inconsistent child",
      summary: "Child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "parent roll-up",
      summary: "Parent summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      supersedesBlockIds: [1],
      summaryTokenEstimate: 8,
      createdAt: Date.now(),
    },
  ]);

  const notifications = await executeDcpCommand(state, makeConfig(), "decompress 2");

  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL — parent should remain active when linkage is inconsistent");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL — child should remain unchanged when linkage is inconsistent");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, undefined, "FAIL — child linkage should remain unchanged");
  assert.strictEqual(notifications[0]?.level, "error", "FAIL — expected an inconsistency error notification");
  assert.ok(
    notifications[0]?.message.includes("child linkage is inconsistent"),
    "FAIL — expected the inconsistent child linkage to be reported",
  );

  console.log("  PASS: inconsistent child linkage is rejected atomically");
  console.log("TEST 34 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 35 — UNBRIDGED PASSTHROUGH MESSAGES ARE NOT SWALLOWED
// ---------------------------------------------------------------------------
{
  console.log("TEST 35: passthrough messages are only expanded when they bridge to a matching result");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "plain assistant" }], timestamp: 2000 },
    { role: "branch_summary", content: "internal summary", timestamp: 2500 },
    { role: "user", content: [{ type: "text", text: "bye" }], timestamp: 3000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "assistant only",
      summary: "Compressed the assistant only.",
      startTimestamp: 2000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);

  const result = applyPruning(messages, state, makeConfig());

  assert.ok(
    result.some((message: any) => message.role === "branch_summary" && message.timestamp === 2500),
    "FAIL — an unbridged passthrough message should remain outside the compressed range",
  );
  assert.ok(
    !result.some((message: any) => message.role === "assistant" && message.timestamp === 2000),
    "FAIL — the selected assistant message should still be compressed",
  );
  assert.ok(
    result.some(
      (message: any) =>
        message.role === "user" &&
        message.timestamp === 2999.5 &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: any) =>
            typeof part.text === "string" &&
            part.text.includes("[Compressed section: assistant only]"),
        ),
    ),
    "FAIL — expected a synthetic summary message for the compressed assistant range",
  );

  console.log("  PASS: unbridged passthrough messages are preserved");
  console.log("TEST 35 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 36 — SWEEP FALLS BACK TO BRANCH TOOL NAMES
// ---------------------------------------------------------------------------
{
  console.log("TEST 36: /dcp sweep protects built-in safe tools even without ToolRecord state");

  const state = makeState();
  const branch = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1000 },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_compress",
        toolName: "compress",
        content: [{ type: "text", text: "compressed" }],
        isError: false,
        timestamp: 2000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_write",
        toolName: "write",
        content: [{ type: "text", text: "wrote file" }],
        isError: false,
        timestamp: 3000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_edit",
        toolName: "edit",
        content: [{ type: "text", text: "edited file" }],
        isError: false,
        timestamp: 4000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_read",
        toolName: "read",
        content: [{ type: "text", text: "read file" }],
        isError: false,
        timestamp: 5000,
      },
    },
  ];

  const notifications = await executeDcpCommand(state, makeConfig(), "sweep", branch);

  assert.deepStrictEqual([...state.prunedToolIds].sort(), ["toolu_read"], "FAIL — sweep should only prune the unprotected tool output");
  assert.strictEqual(state.totalPruneCount, 1, "FAIL — sweep should contribute exactly one pruning operation");
  assert.strictEqual(notifications[0]?.level, "info", "FAIL — expected an info notification from sweep");
  assert.ok(
    notifications[0]?.message.includes("Swept 1 tool output"),
    "FAIL — expected sweep to report only one pruned tool output",
  );

  console.log("  PASS: /dcp sweep falls back to branch tool names to protect safe outputs");
  console.log("TEST 36 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 37 — TOKEN SAVINGS ARE COUNTED ONLY ONCE PER BLOCK
// ---------------------------------------------------------------------------
{
  console.log("TEST 37: tokensSaved does not grow on repeated application of the same block");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha ".repeat(80) }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta ".repeat(80) }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 3000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first slice",
      summary: "Short summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);

  applyPruning(messages, state, makeConfig());
  const firstTokensSaved = state.tokensSaved;
  applyPruning(messages, state, makeConfig());

  assert.ok(firstTokensSaved > 0, "FAIL — expected the first pruning pass to count some saved tokens");
  assert.strictEqual(
    state.tokensSaved,
    firstTokensSaved,
    "FAIL — repeated pruning passes should not recount savings for the same active block",
  );
  assert.strictEqual(state.compressionBlocks[0]?.savingsApplied, true, "FAIL — expected the block to record that its savings were counted");

  console.log("  PASS: token savings remain stable across repeated pruning passes");
  console.log("TEST 37 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 38 — DEDUP PRUNE COUNTS ARE IDEMPOTENT
// ---------------------------------------------------------------------------
{
  console.log("TEST 38: deduplication does not recount pruning operations on repeated passes");

  const config = makeConfig();
  config.strategies.deduplication.enabled = true;

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_old", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "toolu_new", name: "read", arguments: { path: "a.txt" } },
      ],
      timestamp: 1500,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_old",
      toolName: "read",
      content: [{ type: "text", text: "first output" }],
      isError: false,
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_new",
      toolName: "read",
      content: [{ type: "text", text: "second output" }],
      isError: false,
      timestamp: 3000,
    },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_old", {
    toolCallId: "toolu_old",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 2000,
    tokenEstimate: 10,
  });
  state.toolCalls.set("toolu_new", {
    toolCallId: "toolu_new",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 3000,
    tokenEstimate: 10,
  });

  applyPruning(messages, state, config);
  const firstPruneCount = state.totalPruneCount;
  applyPruning(messages, state, config);

  assert.deepStrictEqual([...state.prunedToolIds], ["toolu_old"], "FAIL — deduplication should prune only the older duplicate");
  assert.strictEqual(firstPruneCount, 1, "FAIL — first deduplication pass should record exactly one pruning operation");
  assert.strictEqual(state.totalPruneCount, firstPruneCount, "FAIL — repeated deduplication passes should not inflate totalPruneCount");

  console.log("  PASS: deduplication prune counts remain stable across repeated passes");
  console.log("TEST 38 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 39 — ERROR PURGE COUNTS ARE IDEMPOTENT
// ---------------------------------------------------------------------------
{
  console.log("TEST 39: error purging does not recount pruning operations on repeated passes");

  const config = makeConfig();
  config.strategies.purgeErrors.enabled = true;
  config.strategies.purgeErrors.turns = 3;

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "turn 1" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_error", name: "read", arguments: { path: "a.txt" } }],
      timestamp: 1250,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_error",
      toolName: "read",
      content: [{ type: "text", text: "error output" }],
      isError: true,
      timestamp: 1500,
    },
    { role: "user", content: [{ type: "text", text: "turn 2" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "turn 3" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "turn 4" }], timestamp: 4000 },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_error", {
    toolCallId: "toolu_error",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: true,
    turnIndex: 0,
    timestamp: 1500,
    tokenEstimate: 10,
  });

  applyPruning(messages, state, config);
  const firstPruneCount = state.totalPruneCount;
  applyPruning(messages, state, config);

  assert.deepStrictEqual([...state.prunedToolIds], ["toolu_error"], "FAIL — error purging should prune the stale error output");
  assert.strictEqual(firstPruneCount, 1, "FAIL — first error-purge pass should record exactly one pruning operation");
  assert.strictEqual(state.totalPruneCount, firstPruneCount, "FAIL — repeated error-purge passes should not inflate totalPruneCount");

  console.log("  PASS: error-purge prune counts remain stable across repeated passes");
  console.log("TEST 39 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 40 — AUTOMATIC PROTECTION USES TOOL RECORD NAMES
// ---------------------------------------------------------------------------
{
  console.log("TEST 40: automatic pruning uses canonical ToolRecord names for protection checks");

  const config = makeConfig();
  config.strategies.deduplication.enabled = true;

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_a", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "toolu_b", name: "read", arguments: { path: "a.txt" } },
      ],
      timestamp: 1500,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_a",
      toolName: "read",
      content: [{ type: "text", text: "first output" }],
      isError: false,
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_b",
      toolName: "read",
      content: [{ type: "text", text: "second output" }],
      isError: false,
      timestamp: 3000,
    },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_a", {
    toolCallId: "toolu_a",
    toolName: "edit",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "edit::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 2000,
    tokenEstimate: 10,
  });
  state.toolCalls.set("toolu_b", {
    toolCallId: "toolu_b",
    toolName: "edit",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "edit::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 3000,
    tokenEstimate: 10,
  });

  applyPruning(messages, state, config);

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL — protected tools should not be pruned even if branch metadata is inconsistent");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL — protected-tool skips should not affect pruning statistics");

  console.log("  PASS: automatic pruning protection honors canonical ToolRecord names");
  console.log("TEST 40 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 41 — SWEEP N TARGETS THE LAST N ELIGIBLE UNPROTECTED OUTPUTS
// ---------------------------------------------------------------------------
{
  console.log("TEST 41: /dcp sweep N skips protected tail entries and still finds the last N unprotected outputs");

  const state = makeState();
  const branch = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1000 },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_read_1",
        toolName: "read",
        content: [{ type: "text", text: "read one" }],
        isError: false,
        timestamp: 2000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_read_2",
        toolName: "read",
        content: [{ type: "text", text: "read two" }],
        isError: false,
        timestamp: 3000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_write",
        toolName: "write",
        content: [{ type: "text", text: "write" }],
        isError: false,
        timestamp: 4000,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "toolu_edit",
        toolName: "edit",
        content: [{ type: "text", text: "edit" }],
        isError: false,
        timestamp: 5000,
      },
    },
  ];

  const notifications = await executeDcpCommand(state, makeConfig(), "sweep 2", branch);

  assert.deepStrictEqual(
    [...state.prunedToolIds].sort(),
    ["toolu_read_1", "toolu_read_2"],
    "FAIL — sweep 2 should prune the last two eligible unprotected outputs even when protected tools are at the tail",
  );
  assert.strictEqual(state.totalPruneCount, 2, "FAIL — sweep should count both newly pruned outputs");
  assert.ok(
    notifications[0]?.message.includes("Swept 2 tool outputs"),
    "FAIL — expected sweep to report two pruned outputs",
  );

  console.log("  PASS: /dcp sweep N selects the last N eligible unprotected outputs");
  console.log("TEST 41 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 42 — GLOBAL PROTECTED TOOLS APPLY TO DEDUPLICATION
// ---------------------------------------------------------------------------
{
  console.log("TEST 42: config.compress.protectedTools prevents dedup pruning");

  const config = makeConfig();
  config.strategies.deduplication.enabled = true;
  config.compress.protectedTools = ["compress", "write", "edit", "read"];

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_old", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "toolu_new", name: "read", arguments: { path: "a.txt" } },
      ],
      timestamp: 1500,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_old",
      toolName: "read",
      content: [{ type: "text", text: "first output" }],
      isError: false,
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_new",
      toolName: "read",
      content: [{ type: "text", text: "second output" }],
      isError: false,
      timestamp: 3000,
    },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_old", {
    toolCallId: "toolu_old",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 2000,
    tokenEstimate: 10,
  });
  state.toolCalls.set("toolu_new", {
    toolCallId: "toolu_new",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: false,
    turnIndex: 0,
    timestamp: 3000,
    tokenEstimate: 10,
  });

  applyPruning(messages, state, config);

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL — globally protected tools should be excluded from dedup pruning");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL — globally protected-tool skips should not affect pruning statistics");

  console.log("  PASS: config.compress.protectedTools is honored by deduplication");
  console.log("TEST 42 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 43 — GLOBAL PROTECTED TOOLS APPLY TO ERROR PURGING
// ---------------------------------------------------------------------------
{
  console.log("TEST 43: config.compress.protectedTools prevents error purging");

  const config = makeConfig();
  config.strategies.purgeErrors.enabled = true;
  config.strategies.purgeErrors.turns = 3;
  config.compress.protectedTools = ["compress", "write", "edit", "read"];

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "turn 1" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_error", name: "read", arguments: { path: "a.txt" } }],
      timestamp: 1250,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_error",
      toolName: "read",
      content: [{ type: "text", text: "error output" }],
      isError: true,
      timestamp: 1500,
    },
    { role: "user", content: [{ type: "text", text: "turn 2" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "turn 3" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "turn 4" }], timestamp: 4000 },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_error", {
    toolCallId: "toolu_error",
    toolName: "read",
    inputArgs: { path: "a.txt" },
    inputFingerprint: "read::{\"path\":\"a.txt\"}",
    isError: true,
    turnIndex: 0,
    timestamp: 1500,
    tokenEstimate: 10,
  });

  applyPruning(messages, state, config);

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL — globally protected tools should be excluded from error purging");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL — globally protected error-purge skips should not affect pruning statistics");

  console.log("  PASS: config.compress.protectedTools is honored by error purging");
  console.log("TEST 43 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 44 — ROLL-UP PROMPTS PRESERVE SEMANTIC GUIDANCE
// ---------------------------------------------------------------------------
{
  console.log("TEST 44: roll-up prompt text preserves core semantics");

  assertIncludesAll(
    COMPRESS_RANGE_DESCRIPTION,
    [
      "already-compressed child summary",
      "not to the original raw messages",
      "marks the child block inactive/superseded",
      "Future context injects only the new parent block",
      "include every required block placeholder exactly once",
    ],
    "compress tool description",
  );

  assertIncludesAll(
    SYSTEM_PROMPT,
    [
      "roll-up consolidates multiple active compressed blocks into one active parent block",
    ],
    "system prompt",
  );

  assertIncludesAll(
    MANUAL_MODE_SYSTEM_PROMPT,
    [
      "already-compressed child summaries",
      "not raw original messages",
      "accepted roll-ups supersede child blocks",
      "future context shows only the parent block",
    ],
    "manual mode prompt",
  );

  for (const [label, text] of [
    ["strong nudge", CONTEXT_LIMIT_NUDGE_STRONG],
    ["soft nudge", CONTEXT_LIMIT_NUDGE_SOFT],
    ["turn nudge", TURN_NUDGE],
    ["iteration nudge", ITERATION_NUDGE],
  ] as const) {
    assert.ok(text.includes("roll-up"), `FAIL — ${label} should mention roll-up`);
    assert.ok(
      /child summaries|child blocks|parent block|active parent/.test(text),
      `FAIL — ${label} should describe parent/child roll-up semantics`,
    );
  }

  console.log("  PASS: prompt and nudge text preserve roll-up semantics");
  console.log("TEST 44 PASSED\n");
}

console.log("All tests passed.");
