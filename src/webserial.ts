// Web Serial transport for MCUboot serial recovery (SMP over UART).

import { McuMgrError } from './errors.js';
import {
  SMP_HDR_SIZE,
  encodeHeader,
  type SmpGroup,
  type SmpOp,
  type SmpResponse,
} from './smp.js';
import { DEFAULT_LINELENGTH, FrameParser, encodeFrame } from './serial-frame.js';
import type { Transport } from './transport.js';

const DEFAULT_BAUD = 115200;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MTU = 256;

export interface WebSerialOptions {
  baudRate?: number;
  lineLength?: number;
  timeoutMs?: number;
  mtu?: number;
  closePortOnClose?: boolean;
}

export class WebSerialTransport implements Transport {
  private port: SerialPort;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private parser = new FrameParser();
  private waiters: Array<(r: SmpResponse) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private lineLength: number;
  private timeoutMs: number;
  private _mtu: number;
  private closePortOnClose: boolean;
  private seq = 0;
  private readLoop: Promise<void>;
  private closed = false;

  private constructor(
    port: SerialPort,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    options?: WebSerialOptions,
  ) {
    this.port = port;
    this.writer = writer;
    this.reader = reader;
    this.lineLength = options?.lineLength ?? DEFAULT_LINELENGTH;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._mtu = options?.mtu ?? DEFAULT_MTU;
    this.closePortOnClose = options?.closePortOnClose ?? true;
    this.readLoop = this.runReadLoop();
  }

  /** Prompt user to select a serial port and open it. */
  static async requestPort(
    filters?: SerialPortFilter[],
    options?: WebSerialOptions,
  ): Promise<WebSerialTransport> {
    const port = await navigator.serial.requestPort(filters ? { filters } : undefined);
    return WebSerialTransport.fromPort(port, options);
  }

  /** Wrap an already-obtained SerialPort. Opens it if not already open. */
  static async fromPort(
    port: SerialPort,
    options?: WebSerialOptions,
  ): Promise<WebSerialTransport> {
    const baudRate = options?.baudRate ?? DEFAULT_BAUD;
    if (!port.readable || !port.writable) {
      await port.open({ baudRate });
    }
    if (!port.readable || !port.writable) {
      throw new McuMgrError('Serial port has no readable/writable streams');
    }
    const writer = port.writable.getWriter();
    const reader = port.readable.getReader();
    return new WebSerialTransport(port, writer, reader, options);
  }

  get mtu(): number {
    return this._mtu;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.writer.close();
    } catch {
      /* ignore */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* ignore */
    }
    await this.readLoop.catch(() => {});
    if (this.closePortOnClose) {
      try {
        await this.port.close();
      } catch {
        /* ignore */
      }
    }
    const err = new McuMgrError('Transport closed');
    for (const reject of this.rejecters) reject(err);
    this.waiters = [];
    this.rejecters = [];
  }

  async transceive(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body: Uint8Array,
  ): Promise<SmpResponse> {
    const seq = this.nextSeq();
    const header = encodeHeader({ op, flags: 0, len: body.length, group, seq, id });
    const packet = new Uint8Array(SMP_HDR_SIZE + body.length);
    packet.set(header, 0);
    packet.set(body, SMP_HDR_SIZE);
    const wire = encodeFrame(packet, this.lineLength);

    const responsePromise = this.waitForResponse(seq);
    await this.writer.write(wire);
    return responsePromise;
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return seq;
  }

  private waitForResponse(expectedSeq: number): Promise<SmpResponse> {
    return new Promise<SmpResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(onResponse);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          this.rejecters.splice(idx, 1);
        }
        reject(new McuMgrError(`serial read timeout (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      const onResponse = (r: SmpResponse) => {
        if (settled) return;
        if (r.header.seq !== expectedSeq) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.waiters.indexOf(onResponse);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          this.rejecters.splice(idx, 1);
        }
        resolve(r);
      };
      const onError = (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push(onResponse);
      this.rejecters.push(onError);
    });
  }

  private async runReadLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        try {
          this.parser.push(value);
        } catch (e) {
          for (const reject of this.rejecters) reject(e);
          this.waiters = [];
          this.rejecters = [];
          continue;
        }
        let resp = this.parser.shift();
        while (resp) {
          for (const w of this.waiters) w(resp);
          resp = this.parser.shift();
        }
      }
    } catch (e) {
      for (const reject of this.rejecters) reject(e);
      this.waiters = [];
      this.rejecters = [];
    }
  }
}
