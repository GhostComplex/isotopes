import { loggers } from "../../logging/logger.js";

const log = loggers.discord;

const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];
const DEFAULT_MAX_BUFFER_SIZE = 500;

// Send-new-message (not edit-in-place): edit would expose mid-stream truncated
// content. Tail-promise serializes appends so concurrent deltas stay ordered.
export class SegmentedStreamBuffer {
  private buffer = "";
  private readonly maxBufferSize: number;
  private readonly onFlush: (text: string) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(onFlush: (text: string) => Promise<void>, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE) {
    this.onFlush = onFlush;
    this.maxBufferSize = maxBufferSize;
  }

  append(text: string): Promise<void> {
    this.tail = this.tail.then(async () => {
      this.buffer += text;
      await this.tryFlush();
    }).catch((err) => {
      // Don't poison subsequent appends on a transient Discord error.
      this.buffer = "";
      log.warn(`SegmentedStreamBuffer flush failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.tail;
  }

  flushRemaining(): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (this.buffer.length === 0) return;
      const toFlush = this.buffer;
      this.buffer = "";
      await this.onFlush(toFlush);
    }).catch((err) => {
      log.warn(`SegmentedStreamBuffer final flush failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.tail;
  }

  private async tryFlush(): Promise<void> {
    if (this.buffer.length < this.maxBufferSize) return;
    const boundaryIndex = this.findLastBoundary();
    if (boundaryIndex === -1) return;
    const toFlush = this.buffer.slice(0, boundaryIndex);
    this.buffer = this.buffer.slice(boundaryIndex);
    await this.onFlush(toFlush);
  }

  private findLastBoundary(): number {
    let lastIndex = -1;
    for (const boundary of SENTENCE_BOUNDARIES) {
      const idx = this.buffer.lastIndexOf(boundary);
      if (idx !== -1) {
        const endPos = idx + boundary.length;
        if (endPos > lastIndex) lastIndex = endPos;
      }
    }
    return lastIndex;
  }

  getBuffer(): string {
    return this.buffer;
  }
}
