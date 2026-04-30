import { describe, it, expect } from 'vitest';
import { Encoder, decode as cborDecode } from 'cbor-x';
import {
  crc16Xmodem,
  encodeFrame,
  FrameParser,
  FRAME_START,
  FRAME_CONT,
} from '../../src/serial-frame.js';
import { SMP_HDR_SIZE, SmpOp, SmpGroup, encodeHeader, decodeHeader } from '../../src/smp.js';

const cbor = new Encoder({ useRecords: false, tagUint8Array: false });

function makePacket(op: SmpOp, group: SmpGroup, id: number, seq: number, body: Record<string, unknown>) {
  const cborBytes = new Uint8Array(cbor.encode(body));
  const hdr = encodeHeader({ op, flags: 0, len: cborBytes.length, group, seq, id });
  const pkt = new Uint8Array(SMP_HDR_SIZE + cborBytes.length);
  pkt.set(hdr, 0);
  pkt.set(cborBytes, SMP_HDR_SIZE);
  return pkt;
}

describe('crc16Xmodem', () => {
  it('matches known XMODEM/CRC-16-CCITT vectors', () => {
    expect(crc16Xmodem(new TextEncoder().encode('123456789'))).toBe(0x31C3);
    expect(crc16Xmodem(new Uint8Array([]))).toBe(0);
  });
});

describe('encodeFrame', () => {
  it('starts with 0x06 0x09 marker and ends with newline', () => {
    const pkt = makePacket(SmpOp.Read, SmpGroup.Os, 0, 0, {});
    const wire = encodeFrame(pkt, 128);
    expect(wire[0]).toBe(FRAME_START[0]);
    expect(wire[1]).toBe(FRAME_START[1]);
    expect(wire[wire.length - 1]).toBe(0x0a);
  });

  it('uses continuation marker on subsequent lines', () => {
    const big = new Uint8Array(300);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const wire = encodeFrame(big, 64);
    const lines: number[][] = [];
    let cur: number[] = [];
    for (const b of wire) {
      cur.push(b);
      if (b === 0x0a) {
        lines.push(cur);
        cur = [];
      }
    }
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0][0]).toBe(FRAME_START[0]);
    expect(lines[0][1]).toBe(FRAME_START[1]);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i][0]).toBe(FRAME_CONT[0]);
      expect(lines[i][1]).toBe(FRAME_CONT[1]);
    }
  });
});

describe('FrameParser', () => {
  it('round-trips an SMP packet through encode + parse', () => {
    const pkt = makePacket(SmpOp.ReadRsp, SmpGroup.Os, 0, 42, { rc: 0, r: 'hello' });
    const wire = encodeFrame(pkt, 128);
    const p = new FrameParser();
    p.push(wire);
    const resp = p.shift()!;
    expect(resp.header.seq).toBe(42);
    expect(resp.header.op).toBe(SmpOp.ReadRsp);
    expect(resp.body.rc).toBe(0);
    expect(resp.body.r).toBe('hello');
  });

  it('handles bytes split across pushes', () => {
    const pkt = makePacket(SmpOp.WriteRsp, SmpGroup.Image, 1, 7, { rc: 0, off: 64 });
    const wire = encodeFrame(pkt, 64);
    const p = new FrameParser();
    for (let i = 0; i < wire.length; i += 5) {
      p.push(wire.subarray(i, Math.min(i + 5, wire.length)));
    }
    const resp = p.shift()!;
    expect(resp.header.seq).toBe(7);
    expect(resp.body.off).toBe(64);
  });

  it('ignores noise between frames', () => {
    const pkt = makePacket(SmpOp.ReadRsp, SmpGroup.Os, 0, 1, { rc: 0 });
    const wire = encodeFrame(pkt, 128);
    const noisy = new Uint8Array([0x00, 0xff, 0x55, ...wire]);
    const p = new FrameParser();
    p.push(noisy);
    expect(p.shift()).toBeDefined();
  });

  it('parses captured multi-line image-list response from MCUboot (tolerates short body)', () => {
    const hex = '0609414d34424141444541414541414c396d615731685a32567a6e37396b633278766441426b6147467a614668416536455969394f375a33506b5736353564534e66445a786676494336447258726937674679764c6c4a537a302f50747378457636766c39632f463534593070536c517031726a78697263586c4859454e0a041479317774385764325a584a7a615739755a5441754d7934782f37396b633278766441466b6147467a61466841437442452b5a42706570315135646d335553676e6a776c4272473133615a324b4f754f6334704b6d534f4a61692b696335424b41475a517a3846464f794332665955525367704861536d61344f3648410a0414524f7951414764325a584a7a615739755a5441754d7934782f2f393573673d3d0a';
    const buf = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const p = new FrameParser();
    p.push(buf);
    const r = p.shift();
    expect(r).toBeDefined();
    expect(r!.header.op).toBe(SmpOp.ReadRsp);
    expect(r!.header.group).toBe(SmpGroup.Image);
    expect(Array.isArray((r!.body as any).images)).toBe(true);
    expect((r!.body as any).images.length).toBe(2);
  });

  it('throws on bad CRC', () => {
    const pkt = makePacket(SmpOp.ReadRsp, SmpGroup.Os, 0, 1, { rc: 0 });
    const wire = encodeFrame(pkt, 128);
    // Find the newline, corrupt the byte before it (last base64 char on line)
    const nl = wire.indexOf(0x0a);
    const corrupted = wire.slice();
    corrupted[nl - 1] = corrupted[nl - 1] === 0x41 ? 0x42 : 0x41; // flip A<->B
    const p = new FrameParser();
    expect(() => p.push(corrupted)).toThrow();
  });
});
