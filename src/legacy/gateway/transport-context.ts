import type { Transport } from "./types.js";

export interface TransportContext {
  getTransport(): Transport | undefined;
}

/** Late-binding — tools are constructed before transports start. */
export class LazyTransportContext implements TransportContext {
  private transport: Transport | undefined;
  setTransport(transport: Transport): void { this.transport = transport; }
  getTransport(): Transport | undefined { return this.transport; }
}
