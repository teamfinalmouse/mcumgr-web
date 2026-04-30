// Live test: SLX dongle bootloader serial recovery.
// Skips if the device path is not present.

import { existsSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { McuMgrClient } from '../../src/client.js';
import { NodeSerialTransport } from '../../src/node-serial.js';

const DEVICE =
  '/dev/serial/by-id/usb-Finalmouse_StarlightX_Dongle_Bootloader_D6EF2291FB0D77F4-if00';

const present = existsSync(DEVICE);
const d = present ? describe : describe.skip;

d('SLX dongle bootloader (serial)', () => {
  it('returns image list with at least one slot', async () => {
    const transport = new NodeSerialTransport({ path: DEVICE, timeoutMs: 3000 });
    await transport.ready();
    try {
      const client = new McuMgrClient(transport);
      const state = await client.imageList();
      console.log('images:', JSON.stringify(state.images, (_, v) =>
        v instanceof Uint8Array
          ? Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join('')
          : v));
      expect(state.images.length).toBeGreaterThan(0);
      for (const img of state.images) {
        expect(typeof img.version).toBe('string');
        expect(img.hash).toBeInstanceOf(Uint8Array);
        expect(img.hash.length).toBeGreaterThan(0);
      }
    } finally {
      await transport.close();
    }
  });

  it('echo returns rc=8 (NOT_SUPPORTED) since bootloader has no echo', async () => {
    const transport = new NodeSerialTransport({ path: DEVICE, timeoutMs: 3000 });
    await transport.ready();
    try {
      const client = new McuMgrClient(transport);
      let caught: any;
      try {
        await client.echo('hello');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(String(caught)).toContain('rc=8');
    } finally {
      await transport.close();
    }
  });
});
