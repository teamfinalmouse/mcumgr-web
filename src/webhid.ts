// WebHID transport for SMP protocol.
//
// Each HID report carries a 1-byte length prefix followed by SMP data:
//   [ReportID] [Length:1] [SMP data (zero-padded to report size)]

import { decode } from 'cbor-x';
import { McuMgrError } from './errors.js';
import {
  SMP_HDR_SIZE,
  decodeHeader,
  encodeHeader,
  type SmpGroup,
  type SmpHeader,
  type SmpOp,
  type SmpResponse,
} from './smp.js';
import type { Transport } from './transport.js';

const HID_REPORT_SIZE = 63; // report data excluding report ID (matches firmware SMP_HID_REPORT_DATA_SIZE)
const FRAME_HDR_SIZE = 1; // length byte at start of each report
const PAYLOAD_SIZE = HID_REPORT_SIZE - FRAME_HDR_SIZE; // 62 bytes of SMP data per report

const DEFAULT_REPORT_ID_OUT = 0x01;
const DEFAULT_REPORT_ID_IN = 0x01;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MTU = 2048;

export interface WebHidOptions {
  reportIdOut?: number;
  reportIdIn?: number;
  timeoutMs?: number;
  mtu?: number;
  closeDeviceOnClose?: boolean;
}

export class WebHidTransport implements Transport {
  private device: HIDDevice;
  private reportIdOut: number;
  private reportIdIn: number;
  private timeoutMs: number;
  private _mtu: number;
  private closeDeviceOnClose: boolean;
  private seq = 0;

  private constructor(device: HIDDevice, options?: WebHidOptions) {
    this.device = device;
    this.reportIdOut = options?.reportIdOut ?? DEFAULT_REPORT_ID_OUT;
    this.reportIdIn = options?.reportIdIn ?? DEFAULT_REPORT_ID_IN;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._mtu = options?.mtu ?? DEFAULT_MTU;
    this.closeDeviceOnClose = options?.closeDeviceOnClose ?? true;
  }

  /** Prompt user to select a HID device and open it. */
  static async requestDevice(
    filters: HIDDeviceFilter[],
    options?: WebHidOptions,
  ): Promise<WebHidTransport> {
    const devices = await navigator.hid.requestDevice({ filters });
    if (devices.length === 0) {
      throw new McuMgrError('No HID device selected');
    }
    return WebHidTransport.fromDevice(devices[0], options);
  }

  /** Wrap an already-obtained HIDDevice (opens it if not already open). */
  static async fromDevice(
    device: HIDDevice,
    options?: WebHidOptions,
  ): Promise<WebHidTransport> {
    if (!device.opened) {
      await device.open();
    }
    return new WebHidTransport(device, options);
  }

  get mtu(): number {
    return this._mtu;
  }

  async close(): Promise<void> {
    if (this.closeDeviceOnClose && this.device.opened) {
      await this.device.close();
    }
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

    // Assemble full SMP packet: header + CBOR body
    const packet = new Uint8Array(SMP_HDR_SIZE + body.length);
    packet.set(header, 0);
    packet.set(body, SMP_HDR_SIZE);

    // Set up the response listener BEFORE sending to avoid race conditions
    const responsePromise = this.recvSmp();

    await this.sendSmp(packet);

    return responsePromise;
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return seq;
  }

  /** Fragment and send raw SMP bytes as length-prefixed HID OUT reports. */
  private async sendSmp(data: Uint8Array): Promise<void> {
    let offset = 0;

    while (offset < data.length) {
      const chunkEnd = Math.min(offset + PAYLOAD_SIZE, data.length);
      const chunk = data.subarray(offset, chunkEnd);

      // Build report: [length, smp_data..., zero_padding...]
      // WebHID sendReport takes reportId separately, so the report buffer
      // contains only [length_byte, payload, padding].
      const report = new Uint8Array(HID_REPORT_SIZE);
      report[0] = chunk.length;
      report.set(chunk, FRAME_HDR_SIZE);
      // Remaining bytes are already 0 (zero-padded)

      await this.device.sendReport(this.reportIdOut, report);
      offset = chunkEnd;
    }
  }

  /** Reassemble length-prefixed HID IN reports into a complete SMP response. */
  private recvSmp(): Promise<SmpResponse> {
    return new Promise<SmpResponse>((resolve, reject) => {
      const buf: number[] = [];
      let expectedTotal: number | undefined;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.device.removeEventListener('inputreport', onReport);
        reject(
          new McuMgrError(
            `HID read timeout (${this.timeoutMs}ms), received ${buf.length}/${expectedTotal ?? '?'} bytes`,
          ),
        );
      }, this.timeoutMs);

      const onReport = (event: HIDInputReportEvent) => {
        if (settled) return;
        if (event.reportId !== this.reportIdIn) return;

        const reportData = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        if (reportData.length < FRAME_HDR_SIZE) return;

        const smpLen = reportData[0];
        if (smpLen === 0 || smpLen > PAYLOAD_SIZE) return;

        const dataEnd = Math.min(FRAME_HDR_SIZE + smpLen, reportData.length);
        for (let i = FRAME_HDR_SIZE; i < dataEnd; i++) {
          buf.push(reportData[i]);
        }

        // Parse SMP header once we have enough bytes
        if (expectedTotal === undefined && buf.length >= SMP_HDR_SIZE) {
          const hdrBytes = new Uint8Array(buf.slice(0, SMP_HDR_SIZE));
          let hdr: SmpHeader;
          try {
            hdr = decodeHeader(hdrBytes);
          } catch (e) {
            settled = true;
            clearTimeout(timer);
            this.device.removeEventListener('inputreport', onReport);
            reject(e);
            return;
          }
          expectedTotal = SMP_HDR_SIZE + hdr.len;
        }

        if (expectedTotal !== undefined && buf.length >= expectedTotal) {
          settled = true;
          clearTimeout(timer);
          this.device.removeEventListener('inputreport', onReport);

          const raw = new Uint8Array(buf.slice(0, expectedTotal));
          const respHeader = decodeHeader(raw);
          const cborData = raw.slice(SMP_HDR_SIZE, SMP_HDR_SIZE + respHeader.len);

          let body: Record<string, unknown>;
          try {
            body = decode(cborData) as Record<string, unknown>;
          } catch (e) {
            reject(
              new McuMgrError(
                `CBOR decode failed: ${e instanceof Error ? e.message : e}`,
              ),
            );
            return;
          }

          resolve({ header: respHeader, body });
        }
      };

      this.device.addEventListener('inputreport', onReport);
    });
  }
}
