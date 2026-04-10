// src/workspace/state.ts — Workspace bootstrap state tracking
// Tracks the hatch lifecycle via .isotopes/workspace-state.json.

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("workspace:state");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Workspace bootstrap lifecycle state. */
export interface WorkspaceState {
  version: 1;
  /** When BOOTSTRAP.md was first seeded */
  bootstrapSeededAt?: string;
  /** When the agent deleted BOOTSTRAP.md (hatch complete) */
  setupCompletedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = ".isotopes";
const STATE_FILE = "workspace-state.json";

function getStatePath(workspacePath: string): string {
  return path.join(workspacePath, STATE_DIR, STATE_FILE);
}

// ---------------------------------------------------------------------------
// State operations
// ---------------------------------------------------------------------------

/** Default (empty) workspace state. */
function defaultState(): WorkspaceState {
  return { version: 1 };
}

/**
 * Read workspace state from `{workspace}/.isotopes/workspace-state.json`.
 * Returns default state if file does not exist.
 */
export async function readWorkspaceState(workspacePath: string): Promise<WorkspaceState> {
  const statePath = getStatePath(workspacePath);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    return defaultState();
  }
}

/**
 * Write workspace state to `{workspace}/.isotopes/workspace-state.json`.
 * Creates the `.isotopes/` directory if it doesn't exist.
 */
export async function writeWorkspaceState(
  workspacePath: string,
  state: WorkspaceState,
): Promise<void> {
  const stateDir = path.join(workspacePath, STATE_DIR);
  await fs.mkdir(stateDir, { recursive: true });

  const statePath = getStatePath(workspacePath);
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  log.debug(`Wrote workspace state: ${statePath}`);
}

/** Check if workspace setup (hatch) is complete. */
export function isSetupComplete(state: WorkspaceState): boolean {
  return !!state.setupCompletedAt;
}

/**
 * Reconcile workspace state with the current filesystem.
 *
 * Detects:
 * - BOOTSTRAP.md was seeded and has since been deleted → marks setupCompletedAt
 * - Workspace has user content but no state file → marks as legacy (already configured)
 *
 * Returns the (possibly updated) workspace state.
 */
export async function reconcileWorkspaceState(workspacePath: string): Promise<WorkspaceState> {
  const state = await readWorkspaceState(workspacePath);

  // Already completed — nothing to do
  if (state.setupCompletedAt) {
    return state;
  }

  const bootstrapPath = path.join(workspacePath, "BOOTSTRAP.md");
  let bootstrapExists = false;
  try {
    await fs.access(bootstrapPath);
    bootstrapExists = true;
  } catch {
    // BOOTSTRAP.md does not exist
  }

  // If BOOTSTRAP.md exists and we haven't recorded seeding, record it now
  if (bootstrapExists && !state.bootstrapSeededAt) {
    state.bootstrapSeededAt = new Date().toISOString();
    await writeWorkspaceState(workspacePath, state);
    log.info(`Recorded bootstrap seeded at ${state.bootstrapSeededAt}`);
    return state;
  }

  // If BOOTSTRAP.md was seeded but is now gone → hatch complete
  if (state.bootstrapSeededAt && !bootstrapExists) {
    state.setupCompletedAt = new Date().toISOString();
    await writeWorkspaceState(workspacePath, state);
    log.info(`Hatch complete for workspace at ${workspacePath}`);
    return state;
  }

  // Legacy detection: workspace has content but no bootstrap tracking
  if (!state.bootstrapSeededAt && !bootstrapExists) {
    const hasContent = await hasExistingContent(workspacePath);
    if (hasContent) {
      state.setupCompletedAt = new Date().toISOString();
      await writeWorkspaceState(workspacePath, state);
      log.info(`Marked legacy workspace as setup-complete: ${workspacePath}`);
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if workspace has user-created content (not just empty directories). */
async function hasExistingContent(workspacePath: string): Promise<boolean> {
  const contentFiles = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md", "MEMORY.md"];

  for (const filename of contentFiles) {
    try {
      await fs.access(path.join(workspacePath, filename));
      return true;
    } catch {
      // continue
    }
  }

  // Check for memory files
  try {
    const memoryDir = path.join(workspacePath, "memory");
    const entries = await fs.readdir(memoryDir);
    if (entries.some((e) => e.endsWith(".md"))) {
      return true;
    }
  } catch {
    // no memory dir
  }

  return false;
}
