export interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  threadId?: string;
  task: string;
  startedAt: Date;
}

export class TaskRegistry {
  private tasks: Map<string, TaskInfo> = new Map();

  register(taskId: string, sessionId: string, channelId: string, task: string): void {
    this.tasks.set(taskId, {
      taskId,
      sessionId,
      channelId,
      task,
      startedAt: new Date(),
    });
  }

  unregister(taskId: string): void {
    this.tasks.delete(taskId);
  }

  get(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  getBySession(sessionId: string): TaskInfo[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  getByThreadId(threadId: string): TaskInfo | undefined {
    return [...this.tasks.values()].find((t) => t.threadId === threadId);
  }

  setThreadId(taskId: string, threadId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.threadId = threadId;
    }
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()];
  }
}

export const taskRegistry = new TaskRegistry();
