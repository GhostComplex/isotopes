import type { Transport } from "./types.js";

/**
 * Read-only handle for getting the active transport. Tools take this when
 * they need to call back into transport-specific behavior (emoji reactions,
 * typing indicators, edits, ...).
 */
export interface TransportContext {
  getTransport(): Transport | undefined;
}

/**
 * Late-binding container — agent tools are constructed before transports
 * start, so the transport reference is set later via setTransport.
 */
export class LazyTransportContext implements TransportContext {
  private transport: Transport | undefined;
  setTransport(transport: Transport): void { this.transport = transport; }
  getTransport(): Transport | undefined { return this.transport; }
}
