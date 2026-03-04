// Pre-built SMP packets and CBOR bodies for unit tests.

import { Encoder } from 'cbor-x';

const cborEncoder = new Encoder({ useRecords: false, tagUint8Array: false });
import { encodeHeader, SmpOp, SmpGroup, SMP_HDR_SIZE } from '../../src/smp.js';

/** Build a complete SMP packet from header fields and a CBOR-encodable body. */
export function buildSmpPacket(
  header: {
    op: SmpOp;
    group: SmpGroup;
    seq: number;
    id: number;
  },
  body: Record<string, unknown>,
): Uint8Array {
  const cborBody = new Uint8Array(cborEncoder.encode(body));
  const hdr = encodeHeader({
    op: header.op,
    flags: 0,
    len: cborBody.length,
    group: header.group,
    seq: header.seq,
    id: header.id,
  });
  const packet = new Uint8Array(SMP_HDR_SIZE + cborBody.length);
  packet.set(hdr, 0);
  packet.set(cborBody, SMP_HDR_SIZE);
  return packet;
}

/** Echo response: {r: "hello"} */
export const ECHO_RESPONSE = buildSmpPacket(
  { op: SmpOp.WriteRsp, group: SmpGroup.Os, seq: 0, id: 0 },
  { r: 'hello' },
);

/** Image list response with realistic slot 0/1 entries. */
export const IMAGE_LIST_RESPONSE = buildSmpPacket(
  { op: SmpOp.ReadRsp, group: SmpGroup.Image, seq: 0, id: 0 },
  {
    images: [
      {
        image: 0,
        slot: 0,
        version: '1.2.3',
        hash: new Uint8Array(32).fill(0xaa),
        bootable: true,
        pending: false,
        confirmed: true,
        active: true,
        permanent: false,
      },
      {
        image: 0,
        slot: 1,
        version: '1.2.4',
        hash: new Uint8Array(32).fill(0xbb),
        bootable: true,
        pending: true,
        confirmed: false,
        active: false,
        permanent: false,
      },
    ],
  },
);

/** Error response: {rc: 3} */
export const ERROR_RESPONSE = buildSmpPacket(
  { op: SmpOp.WriteRsp, group: SmpGroup.Os, seq: 0, id: 0 },
  { rc: 3 },
);

/** Large packet requiring multi-fragment reassembly (>62 bytes payload). */
export const LARGE_PACKET = buildSmpPacket(
  { op: SmpOp.ReadRsp, group: SmpGroup.Os, seq: 0, id: 7 },
  { output: 'A'.repeat(120) },
);
