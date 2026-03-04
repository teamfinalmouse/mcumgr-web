import type { SmpGroup, SmpOp, SmpResponse } from './smp.js';

/** Async transport interface for SMP communication. */
export interface Transport {
  /** Send an SMP request and return the response. */
  transceive(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body: Uint8Array,
  ): Promise<SmpResponse>;

  /** Close the transport connection. */
  close(): Promise<void>;

  /** Maximum transfer unit (max CBOR body size per request). */
  readonly mtu: number;
}
