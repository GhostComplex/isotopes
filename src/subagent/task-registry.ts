// src/subagent/task-registry.ts — Registry for tracking running subagent tasks
// Maps taskId → metadata, enabling lookup by session/channel for the abort API.

/** Metadata for a running subagent task. */
export interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  /** Thread ID where subagent streams output (if any) */
  threadId?: string;
  startedAt: Date;
}

/**
 * In-memory registry of active subagent tasks.
 *
 * Tracks which tasks are running so they can be listed and cancelled via the
 * REST API. Tasks are registered when spawned and unregistered on completion
 * (success or failure).
 */
export class TaskRegistry {
  private tasks: Map<string, TaskInfo> = new Map();

  /** Register a new running task. */
  register(taskId: string, sessionId: string, channelId: string): void {
    this.tasks.set(taskId, {
      taskId,
      sessionId,
      channelId,
      startedAt: new Date(),
    });
  }

  /** Unregister a completed/cancelled task. */
  unregister(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Get task info by taskId, or undefined if not found. */
  get(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all tasks for a given session. */
  getBySession(sessionId: string): TaskInfo[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  /** Get task by thread ID, or undefined if not found. */
  getByThreadId(threadId: string): TaskInfo | undefined {
    return [...this.tasks.values()].find((t) => t.threadId === threadId);
  }

  /** Set the thread ID for a running task. */
  setThreadId(taskId: string, threadId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.threadId = threadId;
    }
  }

  /** List all running tasks. */
  list(): TaskInfo[] {
    return [...this.tasks.values()];
  }
}

/** Singleton task registry shared across the application. */
export const taskRegistry = new TaskRegistry();
