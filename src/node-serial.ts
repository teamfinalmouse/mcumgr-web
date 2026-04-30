// Node serial transport for MCUboot serial recovery (SMP over UART).

import { SerialPort } from 'serialport';
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

export interface NodeSerialOptions {
  path: string;
  baudRate?: number;
  lineLength?: number;
  timeoutMs?: number;
  mtu?: number;
}

export class NodeSerialTransport implements Transport {
  private port: SerialPort;
  private parser = new FrameParser();
  private waiters: Array<(r: SmpResponse) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private lineLength: number;
  private timeoutMs: number;
  private _mtu: number;
  private seq = 0;
  private opened: Promise<void>;

  constructor(options: NodeSerialOptions) {
    this.lineLength = options.lineLength ?? DEFAULT_LINELENGTH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._mtu = options.mtu ?? DEFAULT_MTU;

    this.port = new SerialPort({
      path: options.path,
      baudRate: options.baudRate ?? DEFAULT_BAUD,
      autoOpen: false,
    });

    this.port.on('data', (chunk: Buffer) => {
      try {
        this.parser.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } catch (e) {
        this.failAll(e);
        return;
      }
      let resp = this.parser.shift();
      while (resp) {
        for (const w of this.waiters) w(resp);
        resp = this.parser.shift();
      }
    });
    this.port.on('error', (e) => this.failAll(e));

    this.opened = new Promise<void>((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  get mtu(): number {
    return this._mtu;
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
    this.failAll(new McuMgrError('Transport closed'));
  }

  async transceive(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body: Uint8Array,
  ): Promise<SmpResponse> {
    await this.opened;
    const seq = this.nextSeq();
    const header = encodeHeader({ op, flags: 0, len: body.length, group, seq, id });
    const packet = new Uint8Array(SMP_HDR_SIZE + body.length);
    packet.set(header, 0);
    packet.set(body, SMP_HDR_SIZE);
    const wire = encodeFrame(packet, this.lineLength);

    const responsePromise = this.waitForResponse(seq);
    await new Promise<void>((resolve, reject) => {
      this.port.write(Buffer.from(wire), (err) => (err ? reject(err) : resolve()));
    });
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
        this.removeListener(onResponse, onError);
        reject(new McuMgrError(`serial read timeout (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      const onResponse = (r: SmpResponse) => {
        if (settled) return;
        if (r.header.seq !== expectedSeq) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(onResponse, onError);
        resolve(r);
      };
      const onError = (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(onResponse, onError);
        reject(e);
      };
      this.waiters.push(onResponse);
      this.rejecters.push(onError);
    });
  }

  private removeListener(
    onResponse: (r: SmpResponse) => void,
    onError: (e: unknown) => void,
  ): void {
    const i = this.waiters.indexOf(onResponse);
    if (i >= 0) this.waiters.splice(i, 1);
    const j = this.rejecters.indexOf(onError);
    if (j >= 0) this.rejecters.splice(j, 1);
  }

  private failAll(err: unknown): void {
    const rejs = this.rejecters.slice();
    this.waiters = [];
    this.rejecters = [];
    for (const r of rejs) r(err);
  }
}
