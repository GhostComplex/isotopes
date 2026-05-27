import fs from "node:fs/promises";
import path from "node:path";
import { isBrandNewWorkspace } from "./templates.js";

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
    return state;
  }

  // If BOOTSTRAP.md was seeded but is now gone → hatch complete
  if (state.bootstrapSeededAt && !bootstrapExists) {
    state.setupCompletedAt = new Date().toISOString();
    await writeWorkspaceState(workspacePath, state);
    return state;
  }

  // Legacy detection: workspace has content but no bootstrap tracking
  if (!state.bootstrapSeededAt && !bootstrapExists) {
    const brandNew = await isBrandNewWorkspace(workspacePath);
    if (!brandNew) {
      state.setupCompletedAt = new Date().toISOString();
      await writeWorkspaceState(workspacePath, state);
    }
  }

  return state;
}
