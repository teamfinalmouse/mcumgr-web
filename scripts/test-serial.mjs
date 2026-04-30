#!/usr/bin/env node
// Quick smoke test: echo + image list over serial against the SLX bootloader.

import { McuMgrClient } from '../dist/client.js';
import { NodeSerialTransport } from '../dist/node-serial.js';

const path =
  process.argv[2] ||
  '/dev/serial/by-id/usb-Finalmouse_StarlightX_Dongle_Bootloader_D6EF2291FB0D77F4-if00';

const transport = new NodeSerialTransport({ path });
await transport.ready();
const client = new McuMgrClient(transport);

try {
  console.log(`[serial] connected: ${path}`);

  console.log('[echo] sending "hello-bootloader"...');
  try {
    const reply = await client.echo('hello-bootloader');
    console.log(`[echo] reply: ${JSON.stringify(reply)}`);
  } catch (e) {
    console.log(`[echo] not supported by this image: ${e.message}`);
  }

  console.log('[image list] requesting...');
  const state = await client.imageList();
  for (const img of state.images) {
    const flags = [
      img.active && 'active',
      img.confirmed && 'confirmed',
      img.pending && 'pending',
      img.bootable && 'bootable',
      img.permanent && 'permanent',
    ]
      .filter(Boolean)
      .join(' ');
    const hex = Array.from(img.hash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    console.log(
      `  image=${img.image} slot=${img.slot} ver=${img.version} hash=${hex} ${flags}`,
    );
  }
} finally {
  await transport.close();
}
