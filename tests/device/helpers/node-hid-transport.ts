// NodeHidTransport — implements Transport via node-hid.

import HID from 'node-hid';
import { decode } from 'cbor-x';
import {
  SMP_HDR_SIZE,
  SmpOp,
  type SmpGroup,
  type SmpHeader,
  type SmpResponse,
  encodeHeader,
  decodeHeader,
} from '../../../src/smp.js';
import type { Transport } from '../../../src/transport.js';

const FRAME_HDR_SIZE = 1;
const PAYLOAD_SIZE = 62;
const RAW_REPORT_DATA = FRAME_HDR_SIZE + PAYLOAD_SIZE; // 63

/** Find the hidraw path for a specific vendor HID interface. */
export function findDevicePath(
  vid: number,
  pid: number,
  iface: number,
): string {
  const devices = HID.devices(vid, pid);
  if (devices.length === 0) {
    throw new Error(
      `No HID device found for ${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`,
    );
  }

  for (const d of devices) {
    if (d.interface === iface && d.path) {
      return d.path;
    }
  }

  const ifaces = devices.map((d) => d.interface);
  throw new Error(
    `Vendor HID interface ${iface} not found for ` +
      `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}. ` +
      `Found interfaces: [${ifaces.join(', ')}]`,
  );
}

export class NodeHidTransport implements Transport {
  private dev: HID.HID;
  private reportIdOut: number;
  private reportIdIn: number;
  private readTimeoutMs: number;
  private _mtu: number;
  private seq = 0;

  constructor(options: {
    vid: number;
    pid: number;
    iface?: number;
    reportIdOut?: number;
    reportIdIn?: number;
    readTimeoutMs?: number;
    mtu?: number;
  }) {
    const iface = options.iface ?? 1;
    this.reportIdOut = options.reportIdOut ?? 3;
    this.reportIdIn = options.reportIdIn ?? 4;
    this.readTimeoutMs = options.readTimeoutMs ?? 30_000;
    this._mtu = options.mtu ?? 512;

    const path = findDevicePath(options.vid, options.pid, iface);
    this.dev = new HID.HID(path);
  }

  get mtu(): number {
    return this._mtu;
  }

  async close(): Promise<void> {
    this.dev.close();
  }

  async transceive(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body: Uint8Array,
  ): Promise<SmpResponse> {
    const seq = this.nextSeq();
    const header = encodeHeader({
      op,
      flags: 0,
      len: body.length,
      group,
      seq,
      id,
    });

    const packet = new Uint8Array(SMP_HDR_SIZE + body.length);
    packet.set(header, 0);
    packet.set(body, SMP_HDR_SIZE);

    this.send(packet);
    return this.receive();
  }

  /** Send a raw SMP packet by writing directly to the HID device. For testing partial writes. */
  rawWrite(data: Uint8Array): void {
    this.dev.write(Array.from(data));
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return seq;
  }

  /** Fragment raw SMP bytes into length-prefixed HID OUT reports. */
  private send(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.subarray(offset, offset + PAYLOAD_SIZE);
      // node-hid write: [reportId, length, smp_data..., zero_padding...]
      // Total: 1 (report ID) + 1 (length) + PAYLOAD_SIZE = 64 bytes
      const report = new Uint8Array(1 + RAW_REPORT_DATA);
      report[0] = this.reportIdOut;
      report[1] = chunk.length;
      report.set(chunk, 2);
      this.dev.write(Array.from(report));
      offset += chunk.length;
    }
  }

  /** Reassemble length-prefixed HID IN reports into a complete SMP response. */
  private receive(): SmpResponse {
    const buf: number[] = [];
    let expectedTotal: number | undefined;

    while (true) {
      const raw = this.dev.readTimeout(this.readTimeoutMs);
      if (!raw || raw.length === 0) {
        throw new Error(
          `HID read timeout (${this.readTimeoutMs}ms), ` +
            `received ${buf.length}/${expectedTotal ?? '?'} bytes`,
        );
      }

      // node-hid returns report ID as first byte when the device uses
      // numbered reports (both hidraw and libusb backends on Linux).
      // Detect by length: RAW_REPORT_DATA (63) = no ID, 64 = has ID.
      let reportData: number[];
      if (raw.length > RAW_REPORT_DATA) {
        const reportId = raw[0];
        if (reportId !== this.reportIdIn) continue;
        reportData = raw.slice(1);
      } else {
        reportData = raw as number[];
      }

      if (reportData.length < FRAME_HDR_SIZE) continue;

      const smpLen = reportData[0];
      if (smpLen === 0 || smpLen > PAYLOAD_SIZE) continue;

      const dataEnd = Math.min(FRAME_HDR_SIZE + smpLen, reportData.length);
      for (let i = FRAME_HDR_SIZE; i < dataEnd; i++) {
        buf.push(reportData[i]);
      }

      if (expectedTotal === undefined && buf.length >= SMP_HDR_SIZE) {
        const hdrBytes = new Uint8Array(buf.slice(0, SMP_HDR_SIZE));
        const hdr = decodeHeader(hdrBytes);
        expectedTotal = SMP_HDR_SIZE + hdr.len;
      }

      if (expectedTotal !== undefined && buf.length >= expectedTotal) {
        const raw = new Uint8Array(buf.slice(0, expectedTotal));
        const respHeader = decodeHeader(raw);
        const cborData = raw.slice(SMP_HDR_SIZE, SMP_HDR_SIZE + respHeader.len);
        const body = decode(cborData) as Record<string, unknown>;
        return { header: respHeader, body };
      }
    }
  }
}
