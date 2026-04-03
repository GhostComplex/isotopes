// src/transports/types.ts — Transport interface

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
