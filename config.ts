import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { parse as parseJsonc } from "jsonc-parser"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DcpConfig {
  enabled: boolean
  debug: boolean
  manualMode: {
    enabled: boolean
    automaticStrategies: boolean // run dedup/purge even in manual mode
  }
  compress: {
    maxContextPercent: number // 0-1, e.g. 0.8 — above this, aggressive nudges
    minContextPercent: number // 0-1, e.g. 0.4 — below this, no nudges
    minRangeMessages: number // minimum visible items per compress range; 0 disables validation
    nudgeFrequency: number // inject nudge every N context events (default: 5)
    iterationNudgeThreshold: number // nudge after N tool calls since last user msg (default: 15)
    nudgeForce: "strong" | "soft"
    protectedTools: string[] // these tool outputs always protected from pruning
    protectUserMessages: boolean
  }
  strategies: {
    deduplication: {
      enabled: boolean
      protectedTools: string[]
    }
    purgeErrors: {
      enabled: boolean
      turns: number // prune error inputs after N user turns (default: 4)
      protectedTools: string[]
    }
  }
  protectedFilePatterns: string[]
  pruneNotification: "off" | "minimal" | "detailed"
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  manualMode: {
    enabled: false,
    automaticStrategies: true,
  },
  compress: {
    maxContextPercent: 0.8,
    minContextPercent: 0.4,
    minRangeMessages: 0,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: ["compress", "write", "edit"],
    protectUserMessages: false,
  },
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
  },
  protectedFilePatterns: [],
  pruneNotification: "detailed",
}

const DEFAULT_CONFIG_FILE_CONTENT = `{
  // Dynamic Context Pruning (DCP) configuration
  // Full schema reference: https://github.com/complexthings/pi-dynamic-context-pruning
  //
  // "$schema": "...",
  //
  // Uncomment and edit properties you want to override:
  //
  // "enabled": true,
  // "debug": false,
  // "manualMode": {
  //   "enabled": false,
  //   "automaticStrategies": true
  // },
  // "compress": {
  //   "maxContextPercent": 0.8,
  //   "minContextPercent": 0.4,
  //   "minRangeMessages": 0,
  //   "nudgeFrequency": 5,
  //   "iterationNudgeThreshold": 15,
  //   "nudgeForce": "soft",
  //   "protectedTools": ["compress", "write", "edit"],
  //   "protectUserMessages": false
  // },
  // "strategies": {
  //   "deduplication": { "enabled": true, "protectedTools": [] },
  //   "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] }
  // },
  // "protectedFilePatterns": [],
  // "pruneNotification": "detailed"
}
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone arrays and plain objects.
 */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneValue(nestedValue)
    }
    return result as T
  }
  return value
}

/**
 * Recursively merge `override` into `base`. Arrays are union-merged (deduped).
 * Returns a new object; does not mutate inputs.
 */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === null || override === undefined) return cloneValue(base)
  if (typeof base !== "object" || typeof override !== "object") {
    return cloneValue(override as T)
  }

  const result: Record<string, unknown> = cloneValue(base as Record<string, unknown>)

  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overVal = (override as Record<string, unknown>)[key]

    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      // Union merge: combine and deduplicate by value
      const combined = [...baseVal, ...overVal]
      result[key] = [...new Set(combined)]
    } else if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      )
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }

  return result as T
}

/**
 * Parse a JSONC file and return a plain object.
 * Returns `{}` on any error (missing file, parse error).
 */
function readJsoncFile(filePath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return {}
  }

  const errors: unknown[] = []
  const parsed = parseJsonc(raw, errors)
  if (errors.length > 0) {
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}

/**
 * Ensure the global config file exists, creating it with a commented default template if missing.
 */
function ensureGlobalConfig(filePath: string): void {
  const dir = path.dirname(filePath)
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, DEFAULT_CONFIG_FILE_CONTENT, "utf8")
    }
  } catch {
    // Best-effort; do not crash if we cannot write
  }
}

/**
 * Resolve the home directory for config loading.
 * Prefer HOME when present so tests and sandboxed launches can override it.
 */
function getHomeDir(): string {
  return process.env["HOME"] || os.homedir()
}

/**
 * Walk up from `startDir` looking for `.pi/dcp.jsonc`.
 * Returns the path if found, otherwise null.
 */
function findProjectConfig(startDir: string): string | null {
  let dir = path.resolve(startDir)
  const root = path.parse(dir).root

  while (true) {
    const candidate = path.join(dir, ".pi", "dcp.jsonc")
    if (fs.existsSync(candidate)) return candidate
    if (dir === root) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the DCP configuration by merging (in order):
 *  1. Built-in defaults
 *  2. ~/.pi/agent/dcp.jsonc  (global; auto-created with a commented default template if missing)
 *  3. $PI_CONFIG_DIR/dcp.jsonc  (if env var is set)
 *  4. <project>/.pi/dcp.jsonc  (walked up from projectDir)
 */
export function loadConfig(projectDir: string): DcpConfig {
  let config: DcpConfig = deepMerge(DEFAULT_CONFIG, {})

  const globalConfigPath = path.join(getHomeDir(), ".pi", "agent", "dcp.jsonc")
  ensureGlobalConfig(globalConfigPath)
  const globalRaw = readJsoncFile(globalConfigPath)
  if (Object.keys(globalRaw).length > 0) {
    config = deepMerge(config, globalRaw as Partial<DcpConfig>)
  }

  const piConfigDir = process.env["PI_CONFIG_DIR"]
  if (piConfigDir) {
    const envConfigPath = path.join(piConfigDir, "dcp.jsonc")
    const envRaw = readJsoncFile(envConfigPath)
    if (Object.keys(envRaw).length > 0) {
      config = deepMerge(config, envRaw as Partial<DcpConfig>)
    }
  }

  const projectConfigPath = findProjectConfig(projectDir)
  if (projectConfigPath) {
    const projectRaw = readJsoncFile(projectConfigPath)
    if (Object.keys(projectRaw).length > 0) {
      config = deepMerge(config, projectRaw as Partial<DcpConfig>)
    }
  }

  return config
}
