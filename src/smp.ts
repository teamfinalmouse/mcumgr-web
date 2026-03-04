// SMP (Simple Management Protocol) header codec, enums, and types.

export const SMP_HDR_SIZE = 8;

export enum SmpOp {
  Read = 0,
  ReadRsp = 1,
  Write = 2,
  WriteRsp = 3,
}

export enum SmpGroup {
  Os = 0,
  Image = 1,
  Stat = 2,
  Config = 3,
  Log = 4,
  Crash = 5,
  Split = 6,
  Run = 7,
  Fs = 8,
  Shell = 9,
  PerUser = 64,
}

export enum OsCmd {
  Echo = 0,
  ConsEchoCtrl = 1,
  TaskStat = 2,
  MpStat = 3,
  DateTimeStr = 4,
  Reset = 5,
  McumgrParams = 6,
  Info = 7,
  BootloaderInfo = 8,
}

export enum ImageCmd {
  State = 0,
  Upload = 1,
  CoreList = 3,
  CoreLoad = 4,
  Erase = 5,
}

export interface SmpHeader {
  op: SmpOp;
  flags: number;
  len: number;
  group: SmpGroup;
  seq: number;
  id: number;
}

export interface SmpResponse {
  header: SmpHeader;
  body: Record<string, unknown>;
}

/** Encode an SMP header into 8 bytes (big-endian). */
export function encodeHeader(hdr: SmpHeader): Uint8Array {
  const buf = new Uint8Array(SMP_HDR_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint8(0, hdr.op);
  view.setUint8(1, hdr.flags);
  view.setUint16(2, hdr.len, false); // big-endian
  view.setUint16(4, hdr.group, false);
  view.setUint8(6, hdr.seq);
  view.setUint8(7, hdr.id);
  return buf;
}

/** Decode an SMP header from raw bytes. */
export function decodeHeader(data: Uint8Array): SmpHeader {
  if (data.length < SMP_HDR_SIZE) {
    throw new Error(`SMP header too short: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    op: view.getUint8(0) as SmpOp,
    flags: view.getUint8(1),
    len: view.getUint16(2, false),
    group: view.getUint16(4, false) as SmpGroup,
    seq: view.getUint8(6),
    id: view.getUint8(7),
  };
}
