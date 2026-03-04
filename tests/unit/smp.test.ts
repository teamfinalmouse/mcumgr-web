import { describe, expect, test } from 'vitest';
import {
  SMP_HDR_SIZE,
  SmpOp,
  SmpGroup,
  encodeHeader,
  decodeHeader,
  type SmpHeader,
} from '../../src/smp.js';

describe('SMP header', () => {
  test('encode produces 8 bytes with correct big-endian layout', () => {
    const hdr: SmpHeader = {
      op: SmpOp.Write,
      flags: 0,
      len: 256,
      group: SmpGroup.Image,
      seq: 42,
      id: 1,
    };
    const buf = encodeHeader(hdr);
    expect(buf.length).toBe(SMP_HDR_SIZE);
    // op=2
    expect(buf[0]).toBe(2);
    // flags=0
    expect(buf[1]).toBe(0);
    // len=256 big-endian: 0x01 0x00
    expect(buf[2]).toBe(1);
    expect(buf[3]).toBe(0);
    // group=1 big-endian: 0x00 0x01
    expect(buf[4]).toBe(0);
    expect(buf[5]).toBe(1);
    // seq=42
    expect(buf[6]).toBe(42);
    // id=1
    expect(buf[7]).toBe(1);
  });

  test('decode Rust test vector: [1,0,0,10,0,1,42,0]', () => {
    // From mcumgr-client hid_transport.rs:292-300
    const data = new Uint8Array([1, 0, 0, 10, 0, 1, 42, 0]);
    const hdr = decodeHeader(data);
    expect(hdr.op).toBe(SmpOp.ReadRsp);
    expect(hdr.flags).toBe(0);
    expect(hdr.len).toBe(10);
    expect(hdr.group).toBe(SmpGroup.Image);
    expect(hdr.seq).toBe(42);
    expect(hdr.id).toBe(0);
  });

  test('roundtrip: encode → decode → same values for all enum variants', () => {
    const ops = [SmpOp.Read, SmpOp.ReadRsp, SmpOp.Write, SmpOp.WriteRsp];
    const groups = [SmpGroup.Os, SmpGroup.Image, SmpGroup.Stat, SmpGroup.Fs];

    for (const op of ops) {
      for (const group of groups) {
        const original: SmpHeader = {
          op,
          flags: 0,
          len: 1234,
          group,
          seq: 255,
          id: 7,
        };
        const encoded = encodeHeader(original);
        const decoded = decodeHeader(encoded);
        expect(decoded).toEqual(original);
      }
    }
  });

  test('throws on buffer < 8 bytes', () => {
    expect(() => decodeHeader(new Uint8Array(7))).toThrow('SMP header too short');
    expect(() => decodeHeader(new Uint8Array(0))).toThrow('SMP header too short');
  });

  test('handles subarray with non-zero byteOffset', () => {
    const backing = new Uint8Array(16);
    const hdr: SmpHeader = {
      op: SmpOp.ReadRsp,
      flags: 0,
      len: 42,
      group: SmpGroup.Os,
      seq: 7,
      id: 3,
    };
    const encoded = encodeHeader(hdr);
    backing.set(encoded, 4);

    const sub = backing.subarray(4, 12);
    expect(sub.byteOffset).toBe(4);

    const decoded = decodeHeader(sub);
    expect(decoded).toEqual(hdr);
  });
});
