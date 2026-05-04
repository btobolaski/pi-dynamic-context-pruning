import type { DcpConfig } from "./config.js"
import type { ToolRecord } from "./state.js"

const ALWAYS_PROTECTED_TOOLS = ["compress", "write", "edit"] as const

/**
 * Build the effective protected-tool set for a pruning path.
 */
export function getProtectedTools(
  config: DcpConfig,
  ...extraGroups: Array<readonly string[] | string[] | undefined>
): Set<string> {
  return new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.compress.protectedTools ?? []),
    ...extraGroups.flatMap((group) => group ?? []),
  ])
}

/**
 * Resolve the canonical tool name, preferring tracked ToolRecord metadata.
 */
export function resolveToolName(record: ToolRecord | undefined, fallback: unknown): string {
  if (record?.toolName) return record.toolName
  return typeof fallback === "string" ? fallback : ""
}
