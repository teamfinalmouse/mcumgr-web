#!/usr/bin/env node
// Raw-bytes capture: send image list request, dump everything received.

import { SerialPort } from 'serialport';
import { Encoder } from 'cbor-x';
import { encodeFrame } from '../dist/serial-frame.js';
import { encodeHeader, SmpOp, SmpGroup } from '../dist/smp.js';

const path = '/dev/serial/by-id/usb-Finalmouse_StarlightX_Dongle_Bootloader_D6EF2291FB0D77F4-if00';
const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));

const cbor = new Encoder({ useRecords: false, tagUint8Array: false });
const body = new Uint8Array(cbor.encode({}));
const hdr = encodeHeader({ op: SmpOp.Read, flags: 0, len: body.length, group: SmpGroup.Image, seq: 0, id: 0 });
const pkt = new Uint8Array(hdr.length + body.length);
pkt.set(hdr);
pkt.set(body, hdr.length);
const wire = encodeFrame(pkt, 128);

let buf = Buffer.alloc(0);
port.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  process.stdout.write(c.toString('utf8').replace(/\x06/g, '\\x06').replace(/\x04/g, '\\x04').replace(/\x09/g, '\\x09').replace(/\x14/g, '\\x14').replace(/\n/g, '\\n\n'));
});

console.log(`>> wire (${wire.length} bytes):`);
console.log(Buffer.from(wire).toString('utf8').replace(/\x06/g, '\\x06').replace(/\x09/g, '\\x09').replace(/\n/g, '\\n\n'));
port.write(Buffer.from(wire));

await new Promise((r) => setTimeout(r, 1500));
console.log('\n--- raw hex ---');
console.log(buf.toString('hex'));
console.log('--- raw len:', buf.length);
port.close();
