/**
 * Minimal self-contained tests for the applyCompressionBlocks logic inside
 * applyPruning.  No test framework - just assert + console.log.
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
  params: { topic: string; ranges: Array<{ startId: string; endId: string; summary: string; supersedes?: string[] }> },
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

  assert.ok(tool, "FAIL - compress tool was not registered");

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
  contextUsage: { tokens: number | null; contextWindow: number } | null = null,
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

  assert.ok(command, "FAIL - dcp command was not registered");

  await command.handler(args, {
    waitForIdle: async () => {},
    getContextUsage() {
      return contextUsage;
    },
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
    assert.ok(text.includes(phrase), `FAIL - ${label} should include: ${phrase}`);
  }
}

function collectDcpIdTags(content: unknown): string[] {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
          .join("\n")
      : "";

  return text.match(/<dcp-id>m\d+<\/dcp-id>/gu) ?? [];
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
// Test 1 - BUG SCENARIO
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
    `FAIL - orphaned tool_use detected: ${orphan}`
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
      `FAIL - assistant(ts=2000) survived but successor is not the matching toolResult ` +
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
      "FAIL - assistant removed but orphaned toolResult still present"
    );
    console.log("  PASS: both assistant and toolResult removed together");
  }

  console.log("TEST 1 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 2 - PASSING SCENARIO
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
    `FAIL - orphaned tool_use detected: ${orphan}`
  );
  console.log("  PASS: no orphaned tool_use in result");

  // 2b. The assistant at ts=2000 must be absent from the result
  const assistantInResult = result.find(
    (m) => m.role === "assistant" && m.timestamp === 2000
  );
  assert.strictEqual(
    assistantInResult,
    undefined,
    `FAIL - assistant(ts=2000) should have been removed but is still present`
  );
  console.log("  PASS: assistant(ts=2000) removed");

  // 2c. The toolResult must also be absent
  const toolResultInResult = result.find(
    (m) => m.role === "toolResult" && m.toolCallId === "toolu_abc"
  );
  assert.strictEqual(
    toolResultInResult,
    undefined,
    `FAIL - toolResult(toolCallId="toolu_abc") should have been removed but is still present`
  );
  console.log("  PASS: toolResult(toolu_abc) removed");

  // 2d. A synthetic summary message should be present
  const synthetic = result.find(
    (m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("Compressed section")
  );
  assert.ok(
    synthetic,
    "FAIL - expected a synthetic [Compressed section] user message in result"
  );
  console.log("  PASS: synthetic summary message present");

  console.log("TEST 2 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 3 - MULTI-TOOLRESULT BACKWARD GAP
//
// assistant has TWO tool_calls (A + B) producing two consecutive toolResult
// messages.  The compression range starts at toolResult_B - meaning there is
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
    assert.ok(toolResultAPresent, "FAIL - assistant present but toolResult_A missing");
    assert.ok(toolResultBPresent, "FAIL - assistant present but toolResult_B missing");
    // Verify ordering: assistant → toolResult_A → toolResult_B
    const aIdx = result.findIndex((m: any) => m.role === "assistant" && m.timestamp === 2000);
    const rAIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
    const rBIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
    assert.ok(aIdx < rAIdx && rAIdx < rBIdx, "FAIL - assistant + toolResult ordering wrong");
    console.log("  PASS: assistant + both toolResults kept as a coherent group");
  } else {
    assert.ok(!toolResultAPresent, "FAIL - assistant removed but orphaned toolResult_A still present");
    assert.ok(!toolResultBPresent, "FAIL - assistant removed but orphaned toolResult_B still present");
    console.log("  PASS: assistant + both toolResults removed atomically");
  }

  console.log("TEST 3 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 4 - BASHEXECUTION FORWARD GAP
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
    assert.ok(bashPresent, "FAIL - assistant present but bashExecution result missing");
    console.log("  PASS: assistant + bashExecution kept as a coherent group");
  } else {
    assert.ok(!bashPresent, "FAIL - assistant removed but orphaned bashExecution still present");
    console.log("  PASS: assistant + bashExecution removed atomically");
  }

  console.log("TEST 4 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 5 - PASSTHROUGH ROLE BETWEEN ASSISTANT AND TOOLRESULT (BACKWARD)
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
  assert.strictEqual(orphan, null, `FAIL - orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_X");
  assert.ok(!assistantPresent, "FAIL - assistant should have been removed");
  assert.ok(!toolResultPresent, "FAIL - toolResult should have been removed");
  console.log("  PASS: assistant + toolResult removed atomically despite compaction in between");

  console.log("TEST 5 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 6 - PASSTHROUGH ROLE BETWEEN TOOLRESULTS (FORWARD EXPANSION)
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
  assert.strictEqual(orphan, null, `FAIL - orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultAPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
  const toolResultBPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
  assert.ok(!assistantPresent, "FAIL - assistant should have been removed");
  assert.ok(!toolResultAPresent, "FAIL - toolResult_A should have been removed");
  assert.ok(!toolResultBPresent, "FAIL - toolResult_B should have been removed");
  console.log("  PASS: assistant + both toolResults removed despite branch_summary in between");

  console.log("TEST 6 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7 - CONTENT MUTATION ISOLATION
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

  // Run applyPruning - this should NOT mutate the originals
  applyPruning(messages, state, config);

  let mutated = false;
  for (let i = 0; i < messages.length; i++) {
    const current = JSON.stringify(messages[i].content);
    if (current !== originalContents[i]) {
      console.log(`  FAIL - message[${i}] content was mutated`);
      console.log(`    before: ${originalContents[i]}`);
      console.log(`    after:  ${current}`);
      mutated = true;
    }
  }

  assert.ok(!mutated, "FAIL - original message content was mutated by applyPruning");
  console.log("  PASS: original message content unchanged after applyPruning");

  console.log("TEST 7 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7A - MESSAGE ID INJECTION IDEMPOTENCE
//
// Verifies that applying pruning to an already-pruned visible message array
// does not accumulate repeated <dcp-id> tags on the same message.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7A: message ID injection is idempotent");

  const messages = makeMessages();
  const state = makeState();
  const config = makeConfig();

  const firstPass = applyPruning(messages, state, config);
  const secondPass = applyPruning(firstPass, state, config);

  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[0]?.content),
    ["<dcp-id>m001</dcp-id>"],
    "FAIL - expected exactly one DCP ID tag on the first user message after re-pruning",
  );
  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[1]?.content),
    ["<dcp-id>m002</dcp-id>"],
    "FAIL - expected exactly one DCP ID tag on the assistant message after re-pruning",
  );
  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[2]?.content),
    ["<dcp-id>m003</dcp-id>"],
    "FAIL - expected exactly one DCP ID tag on the toolResult after re-pruning",
  );
  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[3]?.content),
    ["<dcp-id>m004</dcp-id>"],
    "FAIL - expected exactly one DCP ID tag on the final user message after re-pruning",
  );

  console.log("  PASS: re-pruning already visible messages preserves a single ID tag per message");

  console.log("TEST 7A PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7B - STALE IDS ARE REMOVED WHEN MESSAGES ARE RENUMBERED
//
// Verifies that if a later pruning pass compresses earlier messages and shifts
// visible ordinals, older injected IDs are removed before the new IDs are
// assigned.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7B: stale IDs are removed when visible messages are renumbered");

  const messages = makeMessages();
  const state = makeState();
  const config = makeConfig();

  const firstPass = applyPruning(messages, state, config);
  state.compressionBlocks.push({
    id: 1,
    topic: "tool exchange",
    summary: "The tool interaction was compressed.",
    startTimestamp: 2000,
    endTimestamp: 3000,
    anchorTimestamp: 4000,
    active: true,
    summaryTokenEstimate: 8,
    createdAt: Date.now(),
  });
  state.nextBlockId = 2;

  const secondPass = applyPruning(firstPass, state, config);
  const tailUser = secondPass.find((message: any) => message.timestamp === 4000);
  assert.ok(tailUser, "FAIL - expected the tail user message to remain visible");
  assert.deepStrictEqual(
    collectDcpIdTags(tailUser.content),
    ["<dcp-id>m003</dcp-id>"],
    "FAIL - expected the tail user message to keep only its current renumbered DCP ID",
  );
  assert.ok(
    !JSON.stringify(secondPass).includes("<dcp-id>m004</dcp-id>"),
    "FAIL - expected stale m004 tags to be removed after renumbering",
  );

  console.log("  PASS: renumbering removes stale IDs before fresh IDs are injected");

  console.log("TEST 7B PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7C - STRING CONTENT RENUMBERING SAFETY
//
// Verifies that string-backed message content also drops stale trailing IDs
// before reinjection when the visible message list is renumbered.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7C: string content renumbering removes stale IDs");

  const state = makeState();
  const config = makeConfig();
  const messages = [
    { role: "user", content: "first", timestamp: 1000 },
    { role: "assistant", content: "second", timestamp: 2000 },
    { role: "user", content: "third", timestamp: 3000 },
  ];

  const firstPass = applyPruning(messages, state, config);
  const secondPass = applyPruning([firstPass[1], firstPass[2]], state, config);

  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[0]?.content),
    ["<dcp-id>m001</dcp-id>"],
    "FAIL - expected the renumbered assistant string message to retain only m001",
  );
  assert.deepStrictEqual(
    collectDcpIdTags(secondPass[1]?.content),
    ["<dcp-id>m002</dcp-id>"],
    "FAIL - expected the renumbered user string message to retain only m002",
  );

  console.log("  PASS: string content drops stale IDs when the visible slice is renumbered");

  console.log("TEST 7C PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7D - EMBEDDED ARRAY TEXT TAGS ARE STRIPPED
//
// Verifies that repeated dcp-id lines embedded at the end of a text block
// inside array-backed content are stripped before reinjection.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7D: embedded array text tags are stripped");

  const state = makeState();
  const config = makeConfig();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 17 tests pass. Let me also run the whole-workspace build to ensure nothing else broke:\n<dcp-id>m070</dcp-id>\n<dcp-id>m070</dcp-id>\n<dcp-id>m070</dcp-id>",
        },
      ],
      timestamp: 1000,
    },
  ];

  const result = applyPruning(messages, state, config);

  assert.deepStrictEqual(
    collectDcpIdTags(result[0]?.content),
    ["<dcp-id>m001</dcp-id>"],
    "FAIL - expected embedded stale tags to be replaced by one fresh ID",
  );
  assert.strictEqual(
    result[0]?.content?.[0]?.text.includes("<dcp-id>"),
    false,
    "FAIL - expected the main assistant text block to have embedded dcp-id tags stripped",
  );

  console.log("  PASS: embedded trailing tags inside array text blocks are removed");

  console.log("TEST 7D PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7E - EMBEDDED TAG STRIPPING PRESERVES TOOLCALL ORDERING
//
// Verifies that sanitizing a text block before a toolCall still results in a
// single injected ID block placed before the toolCall.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7E: embedded tag stripping preserves toolCall ordering");

  const state = makeState();
  const config = makeConfig();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Running the build now:\n<dcp-id>m070</dcp-id>\n<dcp-id>m070</dcp-id>",
        },
        { type: "toolCall", id: "toolu_build", name: "bash", arguments: {} },
      ],
      timestamp: 1000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_build",
      toolName: "bash",
      content: [{ type: "text", text: "build output" }],
      isError: false,
      timestamp: 2000,
    },
  ];

  const result = applyPruning(messages, state, config);
  const content = result[0]?.content ?? [];

  assert.deepStrictEqual(
    collectDcpIdTags(content),
    ["<dcp-id>m001</dcp-id>"],
    "FAIL - expected one fresh ID after stripping embedded tags before toolCall",
  );
  assert.strictEqual(
    content[0]?.text.includes("<dcp-id>"),
    false,
    "FAIL - expected the leading assistant text block to have embedded tags stripped",
  );
  assert.strictEqual(content[1]?.type, "text", "FAIL - expected injected ID block before toolCall");
  assert.strictEqual(
    content[1]?.text,
    "\n<dcp-id>m001</dcp-id>",
    "FAIL - expected the fresh DCP ID block immediately before toolCall",
  );
  assert.strictEqual(content[2]?.type, "toolCall", "FAIL - expected toolCall ordering to remain valid");
  assert.ok(
    !content.slice(3).some(
      (block: any) => typeof block?.text === "string" && block.text.includes("<dcp-id>"),
    ),
    "FAIL - expected no DCP ID text after the toolCall",
  );

  console.log("  PASS: embedded-tag cleanup preserves assistant toolCall ordering");

  console.log("TEST 7E PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7F - STALE ID BLOCKS AFTER TOOLCALL ARE REPAIRED
//
// Verifies that if a stale standalone dcp-id block appears after a toolCall,
// pruning removes it and reinserts a fresh ID block before the toolCall.
// ---------------------------------------------------------------------------
{
  console.log("TEST 7F: stale ID blocks after toolCall are repaired");

  const state = makeState();
  const config = makeConfig();
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_build", name: "bash", arguments: {} },
        { type: "text", text: "\n<dcp-id>m070</dcp-id>" },
      ],
      timestamp: 1000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_build",
      toolName: "bash",
      content: [{ type: "text", text: "build output" }],
      isError: false,
      timestamp: 2000,
    },
  ];

  const result = applyPruning(messages, state, config);
  const content = result[0]?.content ?? [];

  assert.deepStrictEqual(
    collectDcpIdTags(content),
    ["<dcp-id>m001</dcp-id>"],
    "FAIL - expected exactly one fresh assistant DCP ID",
  );
  assert.strictEqual(content[0]?.type, "text", "FAIL - expected ID block before toolCall");
  assert.strictEqual(content[0]?.text, "\n<dcp-id>m001</dcp-id>");
  assert.strictEqual(content[1]?.type, "toolCall", "FAIL - expected toolCall after ID block");
  assert.ok(
    !content.slice(2).some(
      (block: any) => typeof block?.text === "string" && block.text.includes("<dcp-id>"),
    ),
    "FAIL - expected stale DCP IDs after toolCall to be removed",
  );

  console.log("  PASS: stale post-toolCall IDs are moved back to the valid position");

  console.log("TEST 7F PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 8 - ORPHANED TOOLRESULT REPAIR
//
// Two compression blocks where the second removes an assistant but forward
// expansion cannot reach its toolResult due to processing order.  The repair
// function should clean up the orphan.
//
// Sequence:
//   user(1000) → assistant_1(2000, toolCall_X) → toolResult_X(3000) →
//   user(4000) → assistant_2(5000, toolCall_Y) → toolResult_Y(6000) → user(7000)
//
// Block 1: [1000..3000] - removes user, assistant_1, toolResult_X
// Block 2: [4000..5000] - removes user, assistant_2 (toolResult_Y is outside)
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
  assert.strictEqual(orphan, null, `FAIL - orphaned tool_use detected: ${orphan}`);

  const orphanedResults = result.filter(
    (m: any) => (m.role === "toolResult" || m.role === "bashExecution") &&
    !result.some((a: any) =>
      a.role === "assistant" &&
      Array.isArray(a.content) &&
      a.content.some((b: any) => b.type === "toolCall" && b.id === m.toolCallId)
    )
  );
  assert.strictEqual(orphanedResults.length, 0, `FAIL - ${orphanedResults.length} orphaned toolResult(s) found`);
  console.log("  PASS: no orphaned tool_use or toolResult in result");

  console.log("TEST 8 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 9 - DIRECT ORPHAN REPAIR (pre-broken state)
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

  const state = makeState(); // no compression blocks - repair runs as safety net
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
  assert.ok(!orphanPresent, "FAIL - orphaned toolResult should have been removed by repair");
  console.log("  PASS: orphaned toolResult removed by repair function");

  console.log("TEST 9 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 10 - CORRUPTED BLOCK WITH NULL/INFINITY TIMESTAMPS (resilience)
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
  assert.strictEqual(result.length, 3, `FAIL - expected 3 messages, got ${result.length}`);
  console.log("  PASS: corrupted block skipped, all original messages preserved");

  console.log("TEST 10 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 11 - MIN RANGE DISABLED BY DEFAULT
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

  assert.deepStrictEqual(result.details.blockIds, [1], "FAIL - expected block id b1");
  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL - expected one compression block");
  console.log("  PASS: single-message range accepted when validation is disabled");

  console.log("TEST 11 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 12 - MIN RANGE REJECTION
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
    "FAIL - expected a minimum-range validation error",
  );
  assert.strictEqual(
    state.compressionBlocks.length,
    0,
    "FAIL - rejected compression should not create a block",
  );
  console.log("  PASS: too-small range rejected with clear guidance");

  console.log("TEST 12 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 13 - MIN RANGE ACCEPTANCE AT THRESHOLD
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

  assert.deepStrictEqual(result.details.blockIds, [1], "FAIL - expected block id b1");
  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL - expected one compression block");
  assert.strictEqual(
    state.compressionBlocks[0]?.startTimestamp,
    2000,
    "FAIL - expected the block to start at m002",
  );
  assert.strictEqual(
    state.compressionBlocks[0]?.endTimestamp,
    4000,
    "FAIL - expected the block to end at m004",
  );
  console.log("  PASS: threshold-sized range accepted");

  console.log("TEST 13 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 14 - BATCHED VALIDATION IS ATOMIC
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
    "FAIL - expected the mixed batch to be rejected",
  );
  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL - rejected batch should create no blocks");
  assert.strictEqual(state.nextBlockId, 1, "FAIL - rejected batch should not advance nextBlockId");
  console.log("  PASS: rejected batch leaves compression state unchanged");

  console.log("TEST 14 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 15 - CONFIG LOADING DEFAULTS AND LAYER PRECEDENCE
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
      "FAIL - minRangeMessages should default to 0",
    );
    assert.ok(
      fs.existsSync(globalConfigPath),
      "FAIL - global config should be auto-created at ~/.pi/agent/dcp.jsonc",
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
      "FAIL - global config should override the default value",
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
      "FAIL - PI_CONFIG_DIR config should override the global config",
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
      "FAIL - project config should override env/global config when discovered from nested directories",
    );
    assert.strictEqual(
      projectConfig.strategies.purgeErrors.turns,
      4,
      "FAIL - unrelated default values should remain intact after layered merges",
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
// Test 16 - CONFIG PARSE ERRORS, ARRAY MERGING, AND LEGACY PATH REGRESSION
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
      "FAIL - legacy ~/.config/pi/dcp.jsonc should be ignored in favor of ~/.pi/agent/dcp.jsonc",
    );
    assert.deepStrictEqual(
      mergedConfig.compress.protectedTools,
      ["compress", "write", "edit", "read"],
      "FAIL - protectedTools should be union-merged and deduplicated across config layers",
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
      "FAIL - malformed env config should be ignored instead of partially applied",
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
// Test 17 - LEGACY-ONLY PATH IS IGNORED AND DEFAULTS ARE ISOLATED
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
      "FAIL - loading config should create the new ~/.pi/agent/dcp.jsonc template even when only the legacy path exists",
    );
    assert.strictEqual(
      configA.compress.minRangeMessages,
      0,
      "FAIL - legacy-only ~/.config/pi/dcp.jsonc should be ignored",
    );
    assert.notStrictEqual(
      configA.compress,
      configB.compress,
      "FAIL - separate loadConfig calls should not share nested config objects",
    );

    configA.compress.protectedTools.push("grep");
    assert.deepStrictEqual(
      configB.compress.protectedTools,
      ["compress", "write", "edit"],
      "FAIL - mutating one loaded config should not affect another or DEFAULT_CONFIG",
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
// Test 18 - Mid-band nudges are cadence-gated
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
    "FAIL - mid-band nudges should not fire before nudgeFrequency is reached",
  );

  const atCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 0);
  assert.strictEqual(
    atCadence,
    "turn",
    "FAIL - mid-band nudges should fire once nudgeFrequency is reached",
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
    "FAIL - nudgeForce=strong should not change mid-band turn nudges into context nudges",
  );

  const iterationBeforeCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 19 }, config, 40);
  assert.strictEqual(
    iterationBeforeCadence,
    null,
    "FAIL - mid-band iteration nudges should not fire before nudgeFrequency is reached",
  );

  const iterationAtCadence = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 40);
  assert.strictEqual(
    iterationAtCadence,
    "iteration",
    "FAIL - mid-band iteration nudges should fire once cadence and iteration thresholds are both reached",
  );

  const belowIterationThreshold = getNudgeType(0.6, { ...makeState(), nudgeCounter: 20 }, config, 39);
  assert.strictEqual(
    belowIterationThreshold,
    "turn",
    "FAIL - mid-band nudges should remain turn nudges until iteration threshold is reached",
  );

  console.log("  PASS: mid-band nudges are cadence-gated");
  console.log("TEST 18 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 19 - Above-max nudges fire immediately
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
    "FAIL - above-max context should trigger a soft nudge immediately regardless of cadence",
  );

  const strongConfig = makeConfig();
  strongConfig.compress.maxContextPercent = 0.8;
  strongConfig.compress.nudgeFrequency = 20;
  strongConfig.compress.nudgeForce = "strong";

  const strongNudge = getNudgeType(0.95, { ...makeState(), nudgeCounter: 0 }, strongConfig, 0);
  assert.strictEqual(
    strongNudge,
    "context-strong",
    "FAIL - above-max context should trigger a strong nudge immediately regardless of cadence",
  );

  const aboveMaxWithManyTools = getNudgeType(0.95, { ...makeState(), nudgeCounter: 0 }, softConfig, 40);
  assert.strictEqual(
    aboveMaxWithManyTools,
    "context-soft",
    "FAIL - above-max context nudges should take precedence over iteration nudges",
  );

  const state = makeState();
  const firstAboveMax = getNudgeType(0.9, state, softConfig, 0);
  assert.strictEqual(
    firstAboveMax,
    "context-soft",
    "FAIL - above-max context should trigger on the first eligible context event",
  );
  state.nudgeCounter = 0;
  const secondAboveMax = getNudgeType(0.9, state, softConfig, 0);
  assert.strictEqual(
    secondAboveMax,
    "context-soft",
    "FAIL - above-max context should trigger again immediately after the counter reset",
  );

  console.log("  PASS: above-max nudges ignore cadence and fire immediately");
  console.log("TEST 19 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 20 - Threshold boundaries
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
    "FAIL - exactly minContextPercent should not trigger a nudge",
  );

  assert.strictEqual(
    getNudgeType(0.5001, { ...makeState(), nudgeCounter: 19 }, config, 999),
    null,
    "FAIL - just above minContextPercent should still respect cadence",
  );

  assert.strictEqual(
    getNudgeType(0.8, { ...makeState(), nudgeCounter: 19 }, config, 0),
    null,
    "FAIL - exactly maxContextPercent should remain cadence-gated",
  );

  assert.strictEqual(
    getNudgeType(0.8, { ...makeState(), nudgeCounter: 20 }, config, 0),
    "turn",
    "FAIL - exactly maxContextPercent should use mid-band turn behavior at cadence",
  );

  assert.strictEqual(
    getNudgeType(0.8001, { ...makeState(), nudgeCounter: 0 }, config, 999),
    "context-soft",
    "FAIL - values above maxContextPercent should immediately trigger context nudges",
  );

  console.log("  PASS: threshold boundaries behave as expected");
  console.log("TEST 20 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 21 - ROLL-UP COMPRESSION CREATES A PARENT BLOCK
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
    "FAIL - expected three visible child compressed sections before the roll-up",
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
            "Combined closed work:\n\nThen the next resolved section concluded.\n\nFinally the last closed section completed.",
          supersedes: ["b1", "b2", "b3"],
        },
      ],
    },
    notifications,
  );

  assert.deepStrictEqual(result.details.blockIds, [4], "FAIL - expected parent block id b4");
  assert.deepStrictEqual(
    result.details.supersededBlockIds,
    [1, 2, 3],
    "FAIL - expected the roll-up result to report superseded child blocks",
  );
  const resultText = result.content?.[0]?.text ?? "";
  assert.ok(
    resultText.includes("Rolled up b1, b2, b3"),
    "FAIL - expected roll-up result text to report superseded child blocks",
  );
  assert.ok(
    resultText.includes("future context shows the new parent block"),
    "FAIL - expected roll-up result text to explain future parent-only rendering",
  );
  assert.ok(
    notifications[0]?.message.includes("rolled up b1, b2, b3"),
    "FAIL - expected detailed notification to report rolled-up child blocks",
  );

  const parent = state.compressionBlocks.find((b) => b.id === 4);
  const parentSummary = parent?.summary ?? "";
  assert.ok(parent, "FAIL - expected the roll-up parent block to exist");
  assert.strictEqual(parent?.active, true, "FAIL - expected the parent block to be active");
  assert.deepStrictEqual(
    parent?.supersedesBlockIds,
    [1, 2, 3],
    "FAIL - expected the parent block to record its child block IDs",
  );
  assert.ok(
    !parentSummary.includes("First slice summary.") &&
      !parentSummary.includes("Second slice summary.") &&
      !parentSummary.includes("Third slice summary."),
    "FAIL - expected the stored parent summary to avoid inlining child summaries",
  );
  assert.ok(
    parentSummary.includes("Combined closed work:") &&
      parentSummary.includes("Then the next resolved section concluded.") &&
      parentSummary.includes("Finally the last closed section completed."),
    "FAIL - expected the stored parent summary to preserve the authored parent text",
  );
  assert.ok(
    !parentSummary.includes("(b1)") && !parentSummary.includes("(b2)") && !parentSummary.includes("(b3)"),
    "FAIL - expected the authored summary not to contain bN placeholder tokens (none were submitted)",
  );

  for (const childId of [1, 2, 3]) {
    const child = state.compressionBlocks.find((b) => b.id === childId);
    assert.strictEqual(child?.active, false, `FAIL - expected child block b${childId} to be inactive`);
    assert.strictEqual(
      child?.supersededByBlockId,
      4,
      `FAIL - expected child block b${childId} to point at parent b4`,
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
    "FAIL - expected only the parent compressed section to remain visible after roll-up",
  );
  assert.ok(
    visibleCompressedSections[0].content[0].text.includes("<dcp-block-id>b4</dcp-block-id>"),
    "FAIL - expected the visible compressed section to be the new parent block",
  );
  assert.strictEqual(parent?.anchorTimestamp, 7000, "FAIL - expected the parent block to anchor on the first visible item after the roll-up range");
  for (const ts of [1000, 2000, 3000, 4000, 5000, 6000]) {
    assert.ok(
      !postRollupVisible.some((m: any) => m.timestamp === ts),
      `FAIL - raw message ts=${ts} should be removed by the roll-up parent`,
    );
  }
  assert.ok(
    postRollupVisible.some((m: any) => m.timestamp === 7000),
    "FAIL - expected the raw message after the roll-up range to remain visible",
  );
  const postRollupText = JSON.stringify(postRollupVisible);
  assert.ok(!postRollupText.includes("b1</dcp-block-id>"), "FAIL - child block b1 should not remain visible");
  assert.ok(!postRollupText.includes("b2</dcp-block-id>"), "FAIL - child block b2 should not remain visible");
  assert.ok(!postRollupText.includes("b3</dcp-block-id>"), "FAIL - child block b3 should not remain visible");

  console.log("  PASS: roll-up created a parent block, anchored correctly, and only the parent remains visible");
  console.log("TEST 21 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 22 - PARTIAL OVERLAP IS REJECTED ATOMICALLY
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
    "FAIL - expected partial overlap validation to reject the range",
  );

  assert.strictEqual(
    state.compressionBlocks.length,
    1,
    "FAIL - rejected partial overlap should not create a new compression block",
  );
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL - existing block should remain active");
  assert.strictEqual(state.nextBlockId, 2, "FAIL - rejected partial overlap should not advance nextBlockId");

  console.log("  PASS: partial overlap rejected without mutating state");
  console.log("TEST 22 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 23 - ROLL-UP SUPERSEDES FIELD IS STRICTLY VALIDATED
// ---------------------------------------------------------------------------
{
  console.log("TEST 23: roll-up compression requires each contained block in supersedes exactly once");

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
            summary: "Repeated child reference attempted in supersedes.",
            supersedes: ["b1", "b1"],
          },
        ],
      }),
    /Missing: b2\..*Duplicated: b1\./s,
    "FAIL - expected strict supersedes validation to reject the malformed roll-up call",
  );

  assert.strictEqual(
    state.compressionBlocks.length,
    2,
    "FAIL - rejected roll-up should not create a parent block",
  );
  assert.strictEqual(state.nextBlockId, 3, "FAIL - rejected roll-up should not advance nextBlockId");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL - child b1 should remain active");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL - child b2 should remain active");

  console.log("  PASS: malformed roll-up supersedes rejected without mutating state");
  console.log("TEST 23 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 24 - DECOMPRESSING A ROLL-UP REACTIVATES DIRECT CHILDREN
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
  assert.ok(listNotifications[0]?.message.includes("Active compression blocks:"), "FAIL - expected the block listing to show the active section");
  assert.ok(listNotifications[0]?.message.includes("Superseded compression blocks:"), "FAIL - expected the block listing to show the superseded section");
  assert.ok(listNotifications[0]?.message.includes("supersedes b1, b2"), "FAIL - expected the active parent to describe its child blocks");

  const decompressNotifications = await executeDcpCommand(state, makeConfig(), "decompress 3");

  assert.strictEqual(state.compressionBlocks[2]?.active, false, "FAIL - expected the parent block to be deactivated");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL - expected child b1 to reactivate");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL - expected child b2 to reactivate");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, undefined, "FAIL - expected child b1 to clear supersededByBlockId");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, undefined, "FAIL - expected child b2 to clear supersededByBlockId");
  assert.ok(
    decompressNotifications[0]?.message.includes("Reactivated direct child blocks: b1, b2"),
    "FAIL - expected parent decompression to report reactivated child blocks",
  );

  console.log("  PASS: /dcp decompress restored the direct child blocks of a roll-up parent");
  console.log("TEST 24 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 25 - EFFECTIVE-RANGE OVERLAP IS REJECTED IN BATCHES
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
    "FAIL - expected effective-range overlap validation to reject the batch",
  );

  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL - rejected effective-overlap batch should create no blocks");
  assert.strictEqual(state.nextBlockId, 1, "FAIL - rejected effective-overlap batch should not advance nextBlockId");

  console.log("  PASS: effective-range overlap is rejected before any block is created");
  console.log("TEST 25 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 26 - UNEXPECTED SUPERSEDES ENTRIES ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 26: roll-up rejects supersedes entries outside the selected range");

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
        topic: "bad supersedes",
        ranges: [
          {
            startId: "b1",
            endId: "b1",
            summary: "Roll-up summary that incorrectly claims to supersede b2 in addition to b1.",
            supersedes: ["b1", "b2"],
          },
        ],
      }),
    /Unexpected: b2\./,
    "FAIL - expected an unexpected-supersedes validation error",
  );

  assert.strictEqual(state.compressionBlocks.length, 2, "FAIL - rejected supersedes validation should not create a new block");
  assert.strictEqual(state.nextBlockId, 3, "FAIL - rejected supersedes validation should not advance nextBlockId");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL - block b1 should remain active");
  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL - block b2 should remain active");

  console.log("  PASS: unexpected supersedes entries are rejected without mutating state");
  console.log("TEST 26 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 27 - ROLL-UP BATCH VALIDATION IS ATOMIC
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
            summary: "Valid roll-up.",
            supersedes: ["b1", "b2"],
          },
          {
            startId: "b3",
            endId: "b4",
            summary: "Invalid roll-up: missing b4 in supersedes.",
            supersedes: ["b3"],
          },
        ],
      }),
    /Missing: b4\./,
    "FAIL - expected the invalid roll-up in the batch to reject the whole batch",
  );

  assert.strictEqual(state.compressionBlocks.length, 4, "FAIL - rejected roll-up batch should not create parent blocks");
  assert.strictEqual(state.nextBlockId, 5, "FAIL - rejected roll-up batch should not advance nextBlockId");
  for (const childId of [1, 2, 3, 4]) {
    const child = state.compressionBlocks.find((b) => b.id === childId);
    assert.strictEqual(child?.active, true, `FAIL - child block b${childId} should remain active after batch rejection`);
    assert.strictEqual(child?.supersededByBlockId, undefined, `FAIL - child block b${childId} should not be superseded after batch rejection`);
  }

  console.log("  PASS: roll-up batch validation remains atomic");
  console.log("TEST 27 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 28 - NESTED DECOMPRESSION REACTIVATES ONLY DIRECT CHILDREN
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

  assert.strictEqual(state.compressionBlocks[4]?.active, false, "FAIL - expected the top parent to deactivate");
  assert.strictEqual(state.compressionBlocks[2]?.active, true, "FAIL - expected direct child b3 to reactivate");
  assert.strictEqual(state.compressionBlocks[3]?.active, true, "FAIL - expected direct child b4 to reactivate");
  assert.strictEqual(state.compressionBlocks[0]?.active, false, "FAIL - grandchild b1 should remain inactive under b3");
  assert.strictEqual(state.compressionBlocks[1]?.active, false, "FAIL - grandchild b2 should remain inactive under b3");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, 3, "FAIL - grandchild b1 should remain superseded by b3");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, 3, "FAIL - grandchild b2 should remain superseded by b3");
  assert.ok(
    notifications[0]?.message.includes("Reactivated direct child blocks: b3, b4"),
    "FAIL - expected nested decompression to report only direct child reactivation",
  );

  console.log("  PASS: nested decompression restores only the direct children of the parent block");
  console.log("TEST 28 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 29 - REVERSED VISIBLE BOUNDARIES ARE REJECTED
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
    "FAIL - expected reversed visible boundaries to be rejected",
  );

  assert.strictEqual(state.compressionBlocks.length, 2, "FAIL - reversed range should not create a new block");
  assert.strictEqual(state.nextBlockId, 3, "FAIL - reversed range should not advance nextBlockId");

  console.log("  PASS: reversed visible boundaries are rejected under the default config");
  console.log("TEST 29 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 30 - NON-ROLL-UP SUPERSEDES ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 30: non-roll-up ranges cannot declare supersedes entries");

  const state = makeState();
  state.messageIdSnapshot.set("m001", 1000);
  state.messageIdSnapshot.set("m002", 2000);

  await assert.rejects(
    () =>
      executeCompressTool(state, makeConfig(), {
        topic: "bad non-roll-up supersedes",
        ranges: [
          {
            startId: "m001",
            endId: "m002",
            summary: "Plain raw range; no contained blocks.",
            supersedes: ["b1"],
          },
        ],
      }),
    /does not fully contain any active compression blocks.*supersedes.*must be omitted or empty/s,
    "FAIL - expected non-roll-up supersedes usage to be rejected",
  );

  assert.strictEqual(state.compressionBlocks.length, 0, "FAIL - rejected non-roll-up supersedes should not create a block");
  assert.strictEqual(state.nextBlockId, 1, "FAIL - rejected non-roll-up supersedes should not advance nextBlockId");

  console.log("  PASS: raw-only ranges reject supersedes entries");
  console.log("TEST 30 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 31 - DECOMPRESSION FAILS ATOMICALLY WHEN A CHILD IS MISSING
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

  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL - parent should remain active when a child is missing");
  assert.strictEqual(state.compressionBlocks[0]?.active, false, "FAIL - existing child should remain inactive when decompression fails");
  assert.strictEqual(notifications[0]?.level, "error", "FAIL - expected a missing-child decompression error");
  assert.ok(
    notifications[0]?.message.includes("missing direct child block b2"),
    "FAIL - expected the missing child to be reported",
  );

  console.log("  PASS: missing-child decompression leaves hierarchy unchanged");
  console.log("TEST 31 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 32 - BN RANGES PARTICIPATE IN EFFECTIVE OVERLAP CHECKS
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
            summary: "Roll up earlier work and include the tool-result span.",
            supersedes: ["b1"],
          },
          {
            startId: "m002",
            endId: "m002",
            summary: "Compress only the assistant boundary.",
          },
        ],
      }),
    /after assistant\/tool-result atomic expansion/,
    "FAIL - expected a bN-based effective overlap rejection",
  );

  assert.strictEqual(state.compressionBlocks.length, 1, "FAIL - rejected bN overlap should not create new blocks");
  assert.strictEqual(state.nextBlockId, 2, "FAIL - rejected bN overlap should not advance nextBlockId");

  console.log("  PASS: bN ranges use the same effective overlap model as raw message ranges");
  console.log("TEST 32 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 33 - NESTED ROLL-UPS WORK END-TO-END
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
        summary: "Child parent covering b1 and b2.",
        supersedes: ["b1", "b2"],
      },
    ],
  });

  const childParent = state.compressionBlocks.find((b) => b.id === 4);
  assert.ok(childParent?.active, "FAIL - expected the first nested parent to be active");
  assert.deepStrictEqual(childParent?.supersedesBlockIds, [1, 2], "FAIL - expected b4 to supersede b1 and b2");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, 4, "FAIL - expected b1 to point at b4");
  assert.strictEqual(state.compressionBlocks[1]?.supersededByBlockId, 4, "FAIL - expected b2 to point at b4");
  assert.ok(!childParent?.summary.includes("First leaf summary."), "FAIL - expected nested parent b4 to avoid inlining child b1 summary");
  assert.ok(!childParent?.summary.includes("Second leaf summary."), "FAIL - expected nested parent b4 to avoid inlining child b2 summary");
  assert.ok(!childParent?.summary.includes("(b1)") && !childParent?.summary.includes("(b2)"), "FAIL - expected nested parent b4 to omit bN placeholder tokens");

  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "top roll-up",
    ranges: [
      {
        startId: "b4",
        endId: "b3",
        summary: "Top parent rolling up b4 and b3.",
        supersedes: ["b4", "b3"],
      },
    ],
  });

  const topParent = state.compressionBlocks.find((b) => b.id === 5);
  assert.ok(topParent?.active, "FAIL - expected the top nested parent to be active");
  assert.deepStrictEqual(topParent?.supersedesBlockIds, [4, 3], "FAIL - expected b5 to supersede b4 and b3");
  assert.strictEqual(state.compressionBlocks[2]?.supersededByBlockId, 5, "FAIL - expected b3 to point at b5");
  assert.strictEqual(state.compressionBlocks[3]?.supersededByBlockId, 5, "FAIL - expected b4 to point at b5");
  assert.ok(!topParent?.summary.includes("Third leaf summary."), "FAIL - expected top parent b5 to avoid inlining child b3 summary");
  assert.ok(!topParent?.summary.includes("Child parent"), "FAIL - expected top parent b5 to avoid inlining child b4 summary text");
  assert.ok(!topParent?.summary.includes("(b4)") && !topParent?.summary.includes("(b3)"), "FAIL - expected top parent b5 summary to omit bN placeholder tokens");

  const topVisible = applyPruning(messages, state, config);
  const topVisibleText = JSON.stringify(topVisible);
  assert.ok(topVisibleText.includes("b5</dcp-block-id>"), "FAIL - expected b5 to be visible after the top roll-up");
  assert.ok(!topVisibleText.includes("b4</dcp-block-id>"), "FAIL - b4 should be hidden under the top parent");
  assert.ok(!topVisibleText.includes("b3</dcp-block-id>"), "FAIL - b3 should be hidden under the top parent");
  assert.ok(!topVisibleText.includes("b1</dcp-block-id>"), "FAIL - b1 should remain hidden under b4");
  assert.ok(!topVisibleText.includes("b2</dcp-block-id>"), "FAIL - b2 should remain hidden under b4");

  await executeDcpCommand(state, config, "decompress 5");
  const decompressedVisible = applyPruning(messages, state, config);
  const decompressedText = JSON.stringify(decompressedVisible);
  assert.ok(!decompressedText.includes("b5</dcp-block-id>"), "FAIL - b5 should disappear after decompression");
  assert.ok(decompressedText.includes("b4</dcp-block-id>"), "FAIL - b4 should become visible after decompressing b5");
  assert.ok(decompressedText.includes("b3</dcp-block-id>"), "FAIL - b3 should become visible after decompressing b5");
  assert.ok(!decompressedText.includes("b1</dcp-block-id>"), "FAIL - b1 should stay hidden under active b4");
  assert.ok(!decompressedText.includes("b2</dcp-block-id>"), "FAIL - b2 should stay hidden under active b4");

  console.log("  PASS: nested roll-ups create the correct hierarchy and restore only direct visible children on decompression");
  console.log("TEST 33 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 34 - DECOMPRESSION FAILS ATOMICALLY WHEN CHILD LINKAGE IS INCONSISTENT
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

  assert.strictEqual(state.compressionBlocks[1]?.active, true, "FAIL - parent should remain active when linkage is inconsistent");
  assert.strictEqual(state.compressionBlocks[0]?.active, true, "FAIL - child should remain unchanged when linkage is inconsistent");
  assert.strictEqual(state.compressionBlocks[0]?.supersededByBlockId, undefined, "FAIL - child linkage should remain unchanged");
  assert.strictEqual(notifications[0]?.level, "error", "FAIL - expected an inconsistency error notification");
  assert.ok(
    notifications[0]?.message.includes("child linkage is inconsistent"),
    "FAIL - expected the inconsistent child linkage to be reported",
  );

  console.log("  PASS: inconsistent child linkage is rejected atomically");
  console.log("TEST 34 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 35 - UNBRIDGED PASSTHROUGH MESSAGES ARE NOT SWALLOWED
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
    "FAIL - an unbridged passthrough message should remain outside the compressed range",
  );
  assert.ok(
    !result.some((message: any) => message.role === "assistant" && message.timestamp === 2000),
    "FAIL - the selected assistant message should still be compressed",
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
    "FAIL - expected a synthetic summary message for the compressed assistant range",
  );

  console.log("  PASS: unbridged passthrough messages are preserved");
  console.log("TEST 35 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 36 - SWEEP FALLS BACK TO BRANCH TOOL NAMES
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

  assert.deepStrictEqual([...state.prunedToolIds].sort(), ["toolu_read"], "FAIL - sweep should only prune the unprotected tool output");
  assert.strictEqual(state.totalPruneCount, 1, "FAIL - sweep should contribute exactly one pruning operation");
  assert.strictEqual(notifications[0]?.level, "info", "FAIL - expected an info notification from sweep");
  assert.ok(
    notifications[0]?.message.includes("Swept 1 tool output"),
    "FAIL - expected sweep to report only one pruned tool output",
  );

  console.log("  PASS: /dcp sweep falls back to branch tool names to protect safe outputs");
  console.log("TEST 36 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 37 - TOKEN SAVINGS STAY STABLE ACROSS REPEATED PASSES
// ---------------------------------------------------------------------------
{
  console.log("TEST 37: tokensSaved stays stable across repeated application of the same block");

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

  assert.ok(firstTokensSaved > 0, "FAIL - expected the first pruning pass to count some saved tokens");
  assert.strictEqual(
    state.tokensSaved,
    firstTokensSaved,
    "FAIL - repeated pruning passes should not recount savings for the same active block",
  );
  assert.strictEqual(
    state.compressionBlocks[0]?.tokensSavedEstimate,
    firstTokensSaved,
    "FAIL - expected the block to retain its current token-savings estimate",
  );

  console.log("  PASS: token savings remain stable across repeated pruning passes");
  console.log("TEST 37 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 38 - DEDUP PRUNE COUNTS ARE IDEMPOTENT
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

  assert.deepStrictEqual([...state.prunedToolIds], ["toolu_old"], "FAIL - deduplication should prune only the older duplicate");
  assert.strictEqual(firstPruneCount, 1, "FAIL - first deduplication pass should record exactly one pruning operation");
  assert.strictEqual(state.totalPruneCount, firstPruneCount, "FAIL - repeated deduplication passes should not inflate totalPruneCount");

  console.log("  PASS: deduplication prune counts remain stable across repeated passes");
  console.log("TEST 38 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 39 - ERROR PURGE COUNTS ARE IDEMPOTENT
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

  assert.deepStrictEqual([...state.prunedToolIds], ["toolu_error"], "FAIL - error purging should prune the stale error output");
  assert.strictEqual(firstPruneCount, 1, "FAIL - first error-purge pass should record exactly one pruning operation");
  assert.strictEqual(state.totalPruneCount, firstPruneCount, "FAIL - repeated error-purge passes should not inflate totalPruneCount");

  console.log("  PASS: error-purge prune counts remain stable across repeated passes");
  console.log("TEST 39 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 40 - AUTOMATIC PROTECTION USES TOOL RECORD NAMES
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

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL - protected tools should not be pruned even if branch metadata is inconsistent");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL - protected-tool skips should not affect pruning statistics");

  console.log("  PASS: automatic pruning protection honors canonical ToolRecord names");
  console.log("TEST 40 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 41 - SWEEP N TARGETS THE LAST N ELIGIBLE UNPROTECTED OUTPUTS
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
    "FAIL - sweep 2 should prune the last two eligible unprotected outputs even when protected tools are at the tail",
  );
  assert.strictEqual(state.totalPruneCount, 2, "FAIL - sweep should count both newly pruned outputs");
  assert.ok(
    notifications[0]?.message.includes("Swept 2 tool outputs"),
    "FAIL - expected sweep to report two pruned outputs",
  );

  console.log("  PASS: /dcp sweep N selects the last N eligible unprotected outputs");
  console.log("TEST 41 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 42 - GLOBAL PROTECTED TOOLS APPLY TO DEDUPLICATION
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

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL - globally protected tools should be excluded from dedup pruning");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL - globally protected-tool skips should not affect pruning statistics");

  console.log("  PASS: config.compress.protectedTools is honored by deduplication");
  console.log("TEST 42 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 43 - GLOBAL PROTECTED TOOLS APPLY TO ERROR PURGING
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

  assert.deepStrictEqual([...state.prunedToolIds], [], "FAIL - globally protected tools should be excluded from error purging");
  assert.strictEqual(state.totalPruneCount, 0, "FAIL - globally protected error-purge skips should not affect pruning statistics");

  console.log("  PASS: config.compress.protectedTools is honored by error purging");
  console.log("TEST 43 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 44 - MIXED RAW + BLOCK ROLL-UP SUCCEEDS
// ---------------------------------------------------------------------------
{
  console.log("TEST 44: a roll-up can include raw messages plus a fully contained active block");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "raw before" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "child a" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "child b" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "raw after" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "child block",
      summary: "Child summary.",
      startTimestamp: 2000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 2;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "mixed raw roll-up",
    ranges: [
      {
        startId: "m001",
        endId: "m003",
        summary: "Raw setup happened. Raw follow-up was resolved. Includes the b1 child range.",
        supersedes: ["b1"],
      },
    ],
  });

  const parent = state.compressionBlocks.find((b) => b.id === 2);
  assert.ok(parent?.active, "FAIL - expected the mixed roll-up parent to be active");
  assert.deepStrictEqual(parent?.supersedesBlockIds, [1], "FAIL - expected the mixed roll-up parent to supersede b1");
  assert.strictEqual(parent?.startTimestamp, 1000, "FAIL - expected the mixed roll-up to include the leading raw message");
  assert.strictEqual(parent?.endTimestamp, 4000, "FAIL - expected the mixed roll-up to include the trailing raw message");
  assert.strictEqual(parent?.anchorTimestamp, 5000, "FAIL - expected the mixed roll-up parent to anchor on the next visible raw message");
  assert.ok(!parent?.summary.includes("Child summary."), "FAIL - expected mixed roll-up parent summary to avoid inlining the child summary");
  assert.ok(!parent?.summary.includes("(b1)"), "FAIL - expected mixed roll-up summary to not embed any bN placeholder token");

  const visible = applyPruning(messages, state, config);
  const visibleText = JSON.stringify(visible);
  assert.ok(visibleText.includes("b2</dcp-block-id>"), "FAIL - expected the mixed roll-up parent to be visible");
  assert.ok(!visibleText.includes("b1</dcp-block-id>"), "FAIL - expected the child block to be hidden after mixed roll-up");
  for (const ts of [1000, 2000, 3000, 4000]) {
    assert.ok(!visible.some((m: any) => m.timestamp === ts), `FAIL - ts=${ts} should be hidden under the mixed roll-up parent`);
  }
  assert.ok(visible.some((m: any) => m.timestamp === 5000), "FAIL - expected the tail raw message to remain visible");

  console.log("  PASS: mixed raw-plus-block roll-up creates a single parent block with the correct effective range");
  console.log("TEST 44 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 45 - TERMINAL ROLL-UP USES A FINITE FALLBACK ANCHOR
// ---------------------------------------------------------------------------
{
  console.log("TEST 45: a roll-up that reaches the end of visible context gets a finite fallback anchor");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first child",
      summary: "First child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second child",
      summary: "Second child summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 4001,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "terminal roll-up",
    ranges: [
      {
        startId: "b1",
        endId: "b2",
        summary: "Terminal parent covering b1 and b2.",
        supersedes: ["b1", "b2"],
      },
    ],
  });

  const parent = state.compressionBlocks.find((b) => b.id === 3);
  assert.ok(parent?.active, "FAIL - expected the terminal roll-up parent to be active");
  assert.ok(Number.isFinite(parent?.anchorTimestamp), "FAIL - expected the terminal roll-up anchor to be finite");
  assert.notStrictEqual(JSON.parse(JSON.stringify(parent)).anchorTimestamp, null, "FAIL - expected the terminal roll-up anchor to survive JSON serialization");

  const visible = applyPruning(messages, state, config);
  const compressedSections = visible.filter(
    (m: any) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      typeof m.content[0]?.text === "string" &&
      m.content[0].text.startsWith("[Compressed section:"),
  );
  assert.strictEqual(compressedSections.length, 1, "FAIL - expected only the terminal parent block to remain visible");
  assert.ok(JSON.stringify(compressedSections[0]).includes("b3</dcp-block-id>"), "FAIL - expected the visible terminal parent block to be b3");

  console.log("  PASS: terminal roll-ups use a finite fallback anchor and remain serializable");
  console.log("TEST 45 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 46 - BATCHED ROLL-UPS CAN SUCCEED TOGETHER
// ---------------------------------------------------------------------------
{
  console.log("TEST 46: multiple independent roll-up ranges can succeed in one batch");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "gap" }], timestamp: 4500 },
    { role: "user", content: [{ type: "text", text: "e" }], timestamp: 5000 },
    { role: "user", content: [{ type: "text", text: "f" }], timestamp: 6000 },
    { role: "user", content: [{ type: "text", text: "g" }], timestamp: 7000 },
    { role: "user", content: [{ type: "text", text: "h" }], timestamp: 8000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 9000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first pair a",
      summary: "First pair a summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "first pair b",
      summary: "First pair b summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 4500,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 3,
      topic: "second pair a",
      summary: "Second pair a summary.",
      startTimestamp: 5000,
      endTimestamp: 6000,
      anchorTimestamp: 7000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 4,
      topic: "second pair b",
      summary: "Second pair b summary.",
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

  const result = await executeCompressTool(
    state,
    config,
    {
      topic: "batched roll-up",
      ranges: [
        {
          startId: "b1",
          endId: "b2",
          summary: "First parent covering b1 and b2.",
          supersedes: ["b1", "b2"],
        },
        {
          startId: "b3",
          endId: "b4",
          summary: "Second parent covering b3 and b4.",
          supersedes: ["b3", "b4"],
        },
      ],
    },
  );

  assert.deepStrictEqual(result.details.blockIds, [5, 6], "FAIL - expected two new parent block IDs from the batched roll-up");
  assert.deepStrictEqual(result.details.supersededBlockIds, [1, 2, 3, 4], "FAIL - expected the batched roll-up result to report all superseded children");
  assert.deepStrictEqual(state.compressionBlocks.find((b) => b.id === 5)?.supersedesBlockIds, [1, 2], "FAIL - expected b5 to supersede only the first pair");
  assert.deepStrictEqual(state.compressionBlocks.find((b) => b.id === 6)?.supersedesBlockIds, [3, 4], "FAIL - expected b6 to supersede only the second pair");

  const visible = applyPruning(messages, state, config);
  const visibleText = JSON.stringify(visible);
  assert.ok(visibleText.includes("b5</dcp-block-id>"), "FAIL - expected b5 to be visible after batched roll-up");
  assert.ok(visibleText.includes("b6</dcp-block-id>"), "FAIL - expected b6 to be visible after batched roll-up");
  assert.ok(visibleText.includes("gap"), "FAIL - expected the uncompressed gap message to remain visible between batched roll-up parents");
  assert.ok(!visibleText.includes("b1</dcp-block-id>") && !visibleText.includes("b2</dcp-block-id>") && !visibleText.includes("b3</dcp-block-id>") && !visibleText.includes("b4</dcp-block-id>"), "FAIL - expected all child blocks to be hidden after batched roll-up");

  console.log("  PASS: independent roll-up ranges can be validated and committed together");
  console.log("TEST 46 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 47 - MIN-RANGE VALIDATION COUNTS VISIBLE BLOCKS
// ---------------------------------------------------------------------------
{
  console.log("TEST 47: minRangeMessages counts active compressed blocks as visible items");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first child",
      summary: "First child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "second child",
      summary: "Second child summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 4001,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  config.compress.minRangeMessages = 2;
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "too small block roll-up",
        ranges: [
          {
            startId: "b1",
            endId: "b1",
            summary: "Only one child block in range.",
            supersedes: ["b1"],
          },
        ],
      }),
    /covers only 1 visible conversation item\(s\)/,
    "FAIL - expected a single visible block to count as only one item for minRangeMessages",
  );

  const result = await executeCompressTool(state, config, {
    topic: "valid block roll-up",
    ranges: [
      {
        startId: "b1",
        endId: "b2",
        summary: "Both children rolled up together.",
        supersedes: ["b1", "b2"],
      },
    ],
  });

  assert.deepStrictEqual(result.details.blockIds, [3], "FAIL - expected the two-block visible range to satisfy minRangeMessages");

  console.log("  PASS: minRangeMessages measures visible block ranges correctly");
  console.log("TEST 47 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 48 - SUPERSEDES ENTRIES MUST USE CANONICAL bN FORM
// ---------------------------------------------------------------------------
{
  console.log("TEST 48: roll-up supersedes entries require the canonical bN spelling");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "only child",
      summary: "Only child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 2001,
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
        topic: "bad supersedes spelling",
        ranges: [
          {
            startId: "b1",
            endId: "b1",
            summary: "Roll-up of b1 with a non-canonical supersedes entry.",
            supersedes: ["b01"],
          },
        ],
      }),
    /invalid "supersedes" entry "b01".*canonical bN form/s,
    "FAIL - expected b01 not to satisfy the required canonical b1 supersedes entry",
  );

  console.log("  PASS: non-canonical supersedes spellings are rejected");
  console.log("TEST 48 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 49 - CORRUPT ACTIVE BLOCKS DO NOT BLOCK NEW COMPRESSIONS
// ---------------------------------------------------------------------------
{
  console.log("TEST 49: corrupt active blocks are ignored during new compression overlap checks");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 3000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "corrupt block",
      summary: "Corrupt block summary.",
      startTimestamp: Infinity,
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

  const result = await executeCompressTool(state, config, {
    topic: "fresh raw compression",
    ranges: [
      {
        startId: "m001",
        endId: "m002",
        summary: "Fresh raw work was summarized.",
      },
    ],
  });

  assert.deepStrictEqual(result.details.blockIds, [2], "FAIL - expected the new compression block to be created despite the corrupt active block");
  assert.ok(state.compressionBlocks.find((b) => b.id === 2)?.active, "FAIL - expected the new compression block to be active");

  console.log("  PASS: corrupt active blocks do not block valid new compressions");
  console.log("TEST 49 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 50 - ANCHORS RESPECT PASSTHROUGH MESSAGES
// ---------------------------------------------------------------------------
{
  console.log("TEST 50: compression anchors account for visible passthrough messages");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "compress me" }], timestamp: 1000 },
    { role: "branch_summary", content: [{ type: "text", text: "passthrough" }], timestamp: 1500 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
  ];

  const state = makeState();
  const config = makeConfig();
  applyPruning(messages, state, config);

  await executeCompressTool(state, config, {
    topic: "passthrough anchor",
    ranges: [
      {
        startId: "m001",
        endId: "m001",
        summary: "Compressed first user message.",
      },
    ],
  });

  const block = state.compressionBlocks.find((b) => b.id === 1);
  assert.strictEqual(block?.anchorTimestamp, 1500, "FAIL - expected the anchor to target the passthrough message immediately after the range");

  const visible = applyPruning(messages, state, config);
  const compressedIndex = visible.findIndex((m: any) => JSON.stringify(m).includes("b1</dcp-block-id>"));
  const passthroughIndex = visible.findIndex((m: any) => m.role === "branch_summary");
  const tailIndex = visible.findIndex((m: any) => m.timestamp === 2000);
  assert.ok(compressedIndex !== -1, "FAIL - expected the compressed summary to remain visible");
  assert.ok(passthroughIndex !== -1, "FAIL - expected the passthrough message to remain visible");
  assert.ok(compressedIndex < passthroughIndex && passthroughIndex < tailIndex, "FAIL - expected the compressed summary to appear before the passthrough message and tail");

  console.log("  PASS: compression anchors preserve chronology around passthrough messages");
  console.log("TEST 50 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 51 - EMPTY RANGE LISTS ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 51: empty compress requests are rejected");

  const state = makeState();
  const config = makeConfig();

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "empty compression",
        ranges: [],
      }),
    /at least one range/,
    "FAIL - expected empty compress requests to be rejected",
  );

  console.log("  PASS: empty compress requests fail fast");
  console.log("TEST 51 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 54 - ROLL-UP TOKEN SAVINGS REPLACE CHILD SAVINGS
// ---------------------------------------------------------------------------
{
  console.log("TEST 54: roll-up token accounting reflects the active parent rather than child-plus-parent totals");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha ".repeat(80) }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta ".repeat(80) }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "gamma ".repeat(80) }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "delta ".repeat(80) }], timestamp: 4000 },
    { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "first child",
      summary: "First child summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
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
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
  ]);
  state.nextBlockId = 3;

  const config = makeConfig();
  applyPruning(messages, state, config);
  const childSavings = state.tokensSaved;

  await executeCompressTool(state, config, {
    topic: "roll-up parent",
    ranges: [
      {
        startId: "b1",
        endId: "b2",
        summary: "Merged parent summary covering both child ranges.",
        supersedes: ["b1", "b2"],
      },
    ],
  });

  assert.notStrictEqual(
    state.tokensSaved,
    childSavings,
    "FAIL - compress execution should stop reporting superseded child savings immediately",
  );
  assert.strictEqual(
    state.tokensSaved,
    0,
    "FAIL - before the parent is applied, token savings should not include inactive child blocks",
  );

  applyPruning(messages, state, config);
  const rolledUpSavings = state.tokensSaved;

  const statsNotifications = await executeDcpCommand(state, config, "stats");
  assert.ok(
    statsNotifications[0]?.message.includes(
      `Compression tokens saved (estimated): ${rolledUpSavings.toLocaleString()}`,
    ),
    "FAIL - /dcp stats should report active parent-only token savings",
  );
  assert.ok(
    statsNotifications[0]?.message.includes("Compression blocks active: 1 / 3 total"),
    "FAIL - /dcp stats should report only the roll-up parent as active",
  );

  const contextNotifications = await executeDcpCommand(
    state,
    config,
    "context",
    [],
    { tokens: 1234, contextWindow: 10000 },
  );
  assert.ok(
    contextNotifications[0]?.message.includes(
      `Compression tokens saved (estimated): ${rolledUpSavings.toLocaleString()}`,
    ),
    "FAIL - /dcp context should report active parent-only token savings",
  );
  assert.ok(
    contextNotifications[0]?.message.includes("Compression blocks: 1"),
    "FAIL - /dcp context should report only active compression blocks",
  );
  const parent = state.compressionBlocks.find((block) => block.id === 3);
  assert.ok(parent?.active, "FAIL - expected the roll-up parent to be active");

  const expectedState = makeState([
    {
      ...parent!,
      active: true,
      supersedesBlockIds: undefined,
      supersededByBlockId: undefined,
      supersededAt: undefined,
    },
  ]);
  applyPruning(messages, expectedState, config);

  assert.ok(childSavings > 0, "FAIL - expected child blocks to contribute token savings before roll-up");
  assert.strictEqual(
    rolledUpSavings,
    expectedState.tokensSaved,
    "FAIL - roll-up should report only the active parent block's savings",
  );
  assert.notStrictEqual(
    rolledUpSavings,
    childSavings + expectedState.tokensSaved,
    "FAIL - roll-up savings should not double-count superseded child blocks",
  );

  applyPruning(messages, state, config);
  assert.strictEqual(
    state.tokensSaved,
    rolledUpSavings,
    "FAIL - repeated pruning after roll-up should not change token savings",
  );

  console.log("  PASS: roll-up token savings reflect only the active parent block");
  console.log("TEST 54 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 57 - RAW COMPRESSIONS DO NOT REQUIRE ROLL-UP PARENT PROSE
// ---------------------------------------------------------------------------
{
  console.log("TEST 57: terse raw compression summaries remain valid when no child blocks are being rolled up");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
  ];

  const state = makeState();
  const config = makeConfig();
  applyPruning(messages, state, config);

  const result = await executeCompressTool(state, config, {
    topic: "raw terse summary",
    ranges: [
      {
        startId: "m001",
        endId: "m002",
        summary: "OK",
      },
    ],
  });

  assert.deepStrictEqual(result.details.blockIds, [1], "FAIL - expected terse raw summaries without placeholders to remain valid");
  assert.strictEqual(state.compressionBlocks[0]?.summary, "OK", "FAIL - expected the terse raw summary to be stored unchanged");

  console.log("  PASS: terse raw compression summaries remain valid");
  console.log("TEST 57 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 58 - MIN-RANGE COUNTS ALL PASSTHROUGH VISIBLE MESSAGES
// ---------------------------------------------------------------------------
{
  console.log("TEST 58: minRangeMessages counts all passthrough roles as visible items");

  for (const passthroughRole of ["branch_summary", "compaction", "custom_message"] as const) {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
      { role: passthroughRole, content: [{ type: "text", text: "bridge" }], timestamp: 1500 },
      { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
    ];

    const state = makeState();
    const config = makeConfig();
    config.compress.minRangeMessages = 3;
    applyPruning(messages, state, config);

    const result = await executeCompressTool(state, config, {
      topic: `passthrough min range ${passthroughRole}`,
      ranges: [
        {
          startId: "m001",
          endId: "m002",
          summary: `Compressed visible range across ${passthroughRole}.`,
        },
      ],
    });

    assert.deepStrictEqual(
      result.details.blockIds,
      [1],
      `FAIL - ${passthroughRole} should count as a visible passthrough item`,
    );
  }

  console.log("  PASS: minRangeMessages counts all passthrough roles as visible items");
  console.log("TEST 58 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 59 - PASSTHROUGH MIN-RANGE COUNTING STAYS BOUNDED
// ---------------------------------------------------------------------------
{
  console.log("TEST 59: minRangeMessages ignores passthrough messages outside the selected visible range");

  for (const passthroughRole of ["branch_summary", "compaction", "custom_message"] as const) {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "alpha" }], timestamp: 1000 },
      { role: passthroughRole, content: [{ type: "text", text: "inside" }], timestamp: 1500 },
      { role: "user", content: [{ type: "text", text: "beta" }], timestamp: 2000 },
      { role: passthroughRole, content: [{ type: "text", text: "outside" }], timestamp: 2500 },
      { role: "user", content: [{ type: "text", text: "gamma" }], timestamp: 3000 },
    ];

    const state = makeState();
    const config = makeConfig();
    config.compress.minRangeMessages = 4;
    applyPruning(messages, state, config);

    await assert.rejects(
      () =>
        executeCompressTool(state, config, {
          topic: `bounded passthrough count ${passthroughRole}`,
          ranges: [
            {
              startId: "m001",
              endId: "m002",
              summary: "This range should cover only three visible items.",
            },
          ],
        }),
      /covers only 3 visible conversation item\(s\).*requires at least 4/s,
      `FAIL - expected ${passthroughRole} counting to stay bounded to the selected visible range`,
    );
  }

  console.log("  PASS: passthrough min-range counting stays bounded to the selected range");
  console.log("TEST 59 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 60 - ROLL-UP PROMPTS PRESERVE SEMANTIC GUIDANCE
// ---------------------------------------------------------------------------
{
  console.log("TEST 60: roll-up prompt text preserves core semantics");

  assertIncludesAll(
    COMPRESS_RANGE_DESCRIPTION,
    [
      "`supersedes`",
      "list each contained block exactly once",
      "canonical `bN` ids",
      "marked inactive/superseded",
      "future context injects only the new parent block",
      "the call is a roll-up",
    ],
    "compress tool description",
  );

  assertIncludesAll(
    SYSTEM_PROMPT,
    [
      "one or more active compressed blocks",
      "surrounding resolved raw messages",
    ],
    "system prompt",
  );

  assertIncludesAll(
    MANUAL_MODE_SYSTEM_PROMPT,
    [
      "per-range `supersedes` array",
      "list each contained block exactly once",
      "supersedes the listed child blocks",
      "only the new parent block",
    ],
    "manual mode prompt",
  );

  for (const [label, text] of [
    ["strong nudge", CONTEXT_LIMIT_NUDGE_STRONG],
    ["soft nudge", CONTEXT_LIMIT_NUDGE_SOFT],
    ["turn nudge", TURN_NUDGE],
    ["iteration nudge", ITERATION_NUDGE],
  ] as const) {
    assert.ok(text.includes("roll-up"), `FAIL - ${label} should mention roll-up`);
    assert.ok(
      /child blocks|parent block|active parent|supersedes|newly synthesized parent summary/.test(text),
      `FAIL - ${label} should describe parent/child roll-up semantics`,
    );
  }

  console.log("  PASS: prompt and nudge text preserve roll-up semantics");
  console.log("TEST 60 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 61 - INVALID CANONICAL bN SPELLINGS ARE ALL REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 61: canonical bN parsing rejects every malformed spelling");

  const invalidEntries = ["b0", "b01", " b1", "b1 ", "b 1", "B1", "", "b", "b1.0", "b-1"];

  for (const entry of invalidEntries) {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "only child",
        summary: "Only child summary.",
        startTimestamp: 1000,
        endTimestamp: 2000,
        anchorTimestamp: 2001,
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
          topic: "bad supersedes spelling",
          ranges: [
            {
              startId: "b1",
              endId: "b1",
              summary: "Roll-up of b1 with invalid supersedes entry.",
              supersedes: [entry],
            },
          ],
        }),
      /invalid "supersedes" entry.*canonical bN form/s,
      `FAIL - expected supersedes entry ${JSON.stringify(entry)} to be rejected as non-canonical`,
    );
  }

  console.log("  PASS: malformed canonical bN spellings are all rejected");
  console.log("TEST 61 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 62 - ROLL-UP WITH OMITTED SUPERSEDES IS REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 62: roll-up range without an explicit supersedes array is rejected");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "child one",
      summary: "Child one summary.",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 2001,
      active: true,
      summaryTokenEstimate: 5,
      createdAt: Date.now(),
    },
    {
      id: 2,
      topic: "child two",
      summary: "Child two summary.",
      startTimestamp: 3000,
      endTimestamp: 4000,
      anchorTimestamp: 4001,
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
        topic: "missing supersedes",
        ranges: [
          {
            startId: "b1",
            endId: "b2",
            summary: "Parent summary that forgot to declare supersedes.",
          },
        ],
      }),
    /fully contains active block\(s\) b1, b2\..*Pass "supersedes": \["b1", "b2"\]/s,
    "FAIL - expected roll-up without supersedes to be rejected with a guiding error",
  );

  console.log("  PASS: omitted supersedes on a roll-up range is rejected explicitly");
  console.log("TEST 62 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 63 - EMPTY supersedes ARRAY BEHAVIOR
// ---------------------------------------------------------------------------
{
  console.log("TEST 63: empty supersedes is accepted for non-roll-ups and rejected for roll-ups");

  // 63a: non-roll-up range with supersedes: [] succeeds (no contained blocks)
  {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    ];

    const state = makeState();
    const config = makeConfig();
    applyPruning(messages, state, config);

    const result = await executeCompressTool(state, config, {
      topic: "non-roll-up empty supersedes",
      ranges: [
        {
          startId: "m001",
          endId: "m003",
          summary: "Plain raw compression with an explicit empty supersedes.",
          supersedes: [],
        },
      ],
    });

    assert.ok(result, "FAIL - expected non-roll-up with empty supersedes to succeed");
    assert.strictEqual(state.compressionBlocks.length, 1, "FAIL - expected one block created");
    assert.strictEqual(state.compressionBlocks[0]!.active, true, "FAIL - new block should be active");
    assert.strictEqual(
      state.compressionBlocks[0]!.supersedesBlockIds,
      undefined,
      "FAIL - non-roll-up block should not record any superseded children",
    );
  }

  // 63b: roll-up range with supersedes: [] is rejected (missing all children)
  {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
      { role: "user", content: [{ type: "text", text: "d" }], timestamp: 4000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "child one",
        summary: "Child one summary.",
        startTimestamp: 1000,
        endTimestamp: 2000,
        anchorTimestamp: 2001,
        active: true,
        summaryTokenEstimate: 5,
        createdAt: Date.now(),
      },
      {
        id: 2,
        topic: "child two",
        summary: "Child two summary.",
        startTimestamp: 3000,
        endTimestamp: 4000,
        anchorTimestamp: 4001,
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
          topic: "roll-up empty supersedes",
          ranges: [
            {
              startId: "b1",
              endId: "b2",
              summary: "Roll-up parent with an empty supersedes array.",
              supersedes: [],
            },
          ],
        }),
      /Missing: b1, b2\./s,
      "FAIL - expected roll-up with empty supersedes to surface every missing child id",
    );
  }

  console.log("  PASS: empty supersedes is allowed only when no active children are contained");
  console.log("TEST 63 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 64 - UNKNOWN AND INACTIVE supersedes REFERENCES ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 64: supersedes referencing unknown or inactive blocks is rejected");

  // 64a: unknown bN (never existed) on a non-roll-up range is unexpected.
  {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    ];

    const state = makeState();
    const config = makeConfig();
    applyPruning(messages, state, config);

    await assert.rejects(
      () =>
        executeCompressTool(state, config, {
          topic: "unknown supersedes",
          ranges: [
            {
              startId: "m001",
              endId: "m003",
              summary: "Non-roll-up range falsely listing an unknown child.",
              supersedes: ["b999"],
            },
          ],
        }),
      /does not fully contain any active compression blocks.*supersedes.*must be omitted or empty.*Unexpected entries: b999\./s,
      "FAIL - expected unknown bN reference on a non-roll-up range to be rejected as unexpected",
    );
  }

  // 64b: inactive (already superseded) child cannot be re-listed in supersedes.
  // The block exists in state but is inactive, so it is not contained in the active range.
  {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "inactive child",
        summary: "Already superseded child summary.",
        startTimestamp: 1000,
        endTimestamp: 2000,
        anchorTimestamp: 2001,
        active: false,
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
          topic: "inactive supersedes",
          ranges: [
            {
              startId: "m001",
              endId: "m003",
              summary: "Non-roll-up range listing an inactive child as superseded.",
              supersedes: ["b1"],
            },
          ],
        }),
      /does not fully contain any active compression blocks.*Unexpected entries: b1\./s,
      "FAIL - expected inactive child reference to be rejected as unexpected",
    );
  }

  console.log("  PASS: unknown and inactive supersedes references are rejected");
  console.log("TEST 64 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 65 - NON-ARRAY supersedes IS REJECTED WITH A DOMAIN ERROR
// ---------------------------------------------------------------------------
{
  console.log("TEST 65: a malformed (non-array) supersedes value surfaces a domain error");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
    { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3000 },
  ];

  const state = makeState();
  const config = makeConfig();
  applyPruning(messages, state, config);

  await assert.rejects(
    () =>
      executeCompressTool(state, config, {
        topic: "malformed supersedes",
        ranges: [
          {
            startId: "m001",
            endId: "m003",
            summary: "Compression range with a non-array supersedes value.",
            supersedes: "b1" as unknown as string[],
          },
        ],
      }),
    /invalid "supersedes" field: expected an array of bN strings, got string\./,
    "FAIL - expected non-array supersedes value to be rejected with a domain error",
  );

  console.log("  PASS: non-array supersedes values produce a clear domain error");
  console.log("TEST 65 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 66 - NON-STRING supersedes ENTRIES ARE REJECTED
// ---------------------------------------------------------------------------
{
  console.log("TEST 66: malformed (non-string) supersedes entries are rejected with a typed error");

  const malformedEntries = [
    { entry: 1, expectedType: "number" },
    { entry: null, expectedType: "object" },
    { entry: true, expectedType: "boolean" },
    { entry: {}, expectedType: "object" },
  ] as const;

  for (const { entry, expectedType } of malformedEntries) {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "only child",
        summary: "Only child summary.",
        startTimestamp: 1000,
        endTimestamp: 2000,
        anchorTimestamp: 2001,
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
          topic: "bad supersedes element type",
          ranges: [
            {
              startId: "b1",
              endId: "b1",
              summary: "Roll-up of b1 with malformed supersedes entry.",
              supersedes: [entry] as unknown as string[],
            },
          ],
        }),
      new RegExp(`invalid "supersedes" entry: expected a string like "b3", got ${expectedType}\\.`),
      `FAIL - expected supersedes entry ${JSON.stringify(entry)} to be rejected as non-string`,
    );
  }

  console.log("  PASS: non-string supersedes entries are rejected with a typed error");
  console.log("TEST 66 PASSED\n");
}

console.log("All tests passed.");
