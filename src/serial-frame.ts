// MCUboot serial recovery framing (SMP over UART).
//
// Wire format per packet:
//   [start_marker(2)] base64( total_len_be(2) | smp_packet | crc16_xmodem_be(2) ) "\n"
// Multi-line: first line marker = 0x06 0x09, continuation = 0x04 0x14.
// Each line carries up to (linelength - 4) bytes of base64.

import { McuMgrError } from './errors.js';
import {
  SMP_HDR_SIZE,
  decodeHeader,
  type SmpHeader,
  type SmpResponse,
} from './smp.js';
import { decode as cborDecode } from 'cbor-x';

export const FRAME_START = new Uint8Array([0x06, 0x09]);
export const FRAME_CONT = new Uint8Array([0x04, 0x14]);
export const DEFAULT_LINELENGTH = 128;

/** CRC16-XMODEM (poly 0x1021, init 0). */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

function b64Encode(data: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] +
           B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  if (i < data.length) {
    const rem = data.length - i;
    const n = (data[i] << 16) | ((rem === 2 ? data[i + 1] : 0) << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
    out += rem === 2 ? B64_CHARS[(n >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

function b64Decode(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 0x3d /* = */) len--;
  const outLen = ((len * 6) >> 3);
  const out = new Uint8Array(outLen);
  let bits = 0, val = 0, j = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_REV[s.charCodeAt(i)];
    if (v < 0) throw new McuMgrError(`bad base64 char at ${i}`);
    val = (val << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (val >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

/** Encode an SMP packet into one or more newline-terminated framed lines. */
export function encodeFrame(smpPacket: Uint8Array, linelength = DEFAULT_LINELENGTH): Uint8Array {
  const totalLen = smpPacket.length + 2; // +CRC
  const wire = new Uint8Array(2 + smpPacket.length + 2);
  wire[0] = (totalLen >> 8) & 0xff;
  wire[1] = totalLen & 0xff;
  wire.set(smpPacket, 2);
  const crc = crc16Xmodem(wire.subarray(2, 2 + smpPacket.length));
  wire[wire.length - 2] = (crc >> 8) & 0xff;
  wire[wire.length - 1] = crc & 0xff;

  const b64 = b64Encode(wire);
  const perLine = Math.max(1, linelength - 4);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += perLine) {
    chunks.push(b64.slice(i, i + perLine));
  }

  const lines: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const marker = i === 0 ? FRAME_START : FRAME_CONT;
    lines.push(marker[0], marker[1]);
    for (let k = 0; k < chunks[i].length; k++) lines.push(chunks[i].charCodeAt(k));
    lines.push(0x0a);
  }
  return new Uint8Array(lines);
}

/**
 * MCUboot's serial-recovery encoder (zcbor in non-canonical mode) has been
 * observed to omit the closing 0xff break for the outermost indefinite-length
 * map, while reporting the SMP body length as one byte short. Be tolerant:
 * if a strict decode fails, retry with a break byte appended.
 */
function decodeCborTolerant(bytes: Uint8Array): Record<string, unknown> {
  try {
    return cborDecode(bytes) as Record<string, unknown>;
  } catch {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    padded[bytes.length] = 0xff;
    return cborDecode(padded) as Record<string, unknown>;
  }
}

type FrameState = 'idle' | 'collecting';

/**
 * Stream parser: feed it raw RX bytes via push(); call tryRead() to pull
 * complete decoded SMP responses (header + CBOR body). Tolerates noise
 * between frames and bytes split across pushes.
 */
export class FrameParser {
  private state: FrameState = 'idle';
  private line: number[] = [];
  private b64: string = '';
  private expectedTotal = 0;
  private completed: SmpResponse[] = [];
  // First byte of a 2-byte frame marker that was the last byte of the previous
  // push() chunk. USB CDC on Windows splits reads byte-by-byte, so we must
  // remember a lone 0x06 / 0x04 across pushes.
  private pendingMarker: 0x06 | 0x04 | 0 = 0;

  push(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.state === 'idle') {
        if (this.pendingMarker !== 0) {
          const m = this.pendingMarker;
          this.pendingMarker = 0;
          if (m === 0x06 && b === FRAME_START[1]) {
            this.state = 'collecting';
            this.line = [];
            this.b64 = '';
            this.expectedTotal = 0;
            continue;
          }
          if (m === 0x04 && b === FRAME_CONT[1] && this.b64.length > 0) {
            this.state = 'collecting';
            this.line = [];
            continue;
          }
          // Pending marker didn't pair — fall through to evaluate b fresh.
        }
        if (b === FRAME_START[0] || b === FRAME_CONT[0]) {
          if (i + 1 >= bytes.length) {
            this.pendingMarker = b as 0x06 | 0x04;
            break;
          }
          const next = bytes[i + 1];
          if (b === FRAME_START[0] && next === FRAME_START[1]) {
            this.state = 'collecting';
            this.line = [];
            this.b64 = '';
            this.expectedTotal = 0;
            i++;
          } else if (b === FRAME_CONT[0] && next === FRAME_CONT[1] && this.b64.length > 0) {
            this.state = 'collecting';
            this.line = [];
            i++;
          }
        }
        continue;
      }

      if (b === 0x0a) {
        const lineStr = String.fromCharCode(...this.line);
        this.b64 += lineStr;
        this.line = [];
        this.state = 'idle';
        try {
          this.tryFinish();
        } catch (e) {
          this.b64 = '';
          this.expectedTotal = 0;
          throw e;
        }
      } else if (b !== 0x0d) {
        this.line.push(b);
      }
    }
  }

  private tryFinish(): void {
    if (this.b64.length === 0) return;
    const decoded = b64Decode(this.b64);
    if (this.expectedTotal === 0) {
      if (decoded.length < 2) return;
      this.expectedTotal = (decoded[0] << 8) | decoded[1];
    }
    if (decoded.length - 2 < this.expectedTotal) return;

    const smpAndCrc = decoded.subarray(2, 2 + this.expectedTotal);
    if (smpAndCrc.length < SMP_HDR_SIZE + 2) {
      throw new McuMgrError(`frame too short: ${smpAndCrc.length}`);
    }
    const smp = smpAndCrc.subarray(0, smpAndCrc.length - 2);
    const gotCrc = (smpAndCrc[smpAndCrc.length - 2] << 8) | smpAndCrc[smpAndCrc.length - 1];
    const wantCrc = crc16Xmodem(smp);
    if (gotCrc !== wantCrc) {
      this.b64 = '';
      this.expectedTotal = 0;
      throw new McuMgrError(`bad CRC: got 0x${gotCrc.toString(16)}, want 0x${wantCrc.toString(16)}`);
    }

    const header: SmpHeader = decodeHeader(smp);
    if (smp.length < SMP_HDR_SIZE + header.len) {
      throw new McuMgrError(`SMP body short: ${smp.length} < ${SMP_HDR_SIZE + header.len}`);
    }
    const cborBytes = smp.subarray(SMP_HDR_SIZE, SMP_HDR_SIZE + header.len);
    const body = (header.len === 0 ? {} : decodeCborTolerant(cborBytes)) as Record<string, unknown>;
    this.completed.push({ header, body });
    this.b64 = '';
    this.expectedTotal = 0;
  }

  shift(): SmpResponse | undefined {
    return this.completed.shift();
  }

  reset(): void {
    this.state = 'idle';
    this.line = [];
    this.b64 = '';
    this.expectedTotal = 0;
    this.completed = [];
    this.pendingMarker = 0;
  }
}
