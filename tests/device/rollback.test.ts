// MCUboot swap and rollback tests.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { McuMgrClient } from '../../src/client.js';
import { config } from './helpers/device-config.js';
import { NodeHidTransport } from '../../src/node-hid.js';
import { pickAlternateFirmware } from './helpers/firmware-picker.js';
import { waitForDevice, waitForDeviceGone } from './helpers/usb-utils.js';

const { vid, pid } = config;

function openTransport(): NodeHidTransport {
  return new NodeHidTransport({
    vid,
    pid,
    reportIdOut: config.reportIdOut,
    reportIdIn: config.reportIdIn,
  });
}

const hasTwoBinaries = !!config.firmwareBin && !!config.firmwareBinAlt;

describe('MCUboot rollback', () => {
  test.skipIf(!hasTwoBinaries)(
    'swap and confirm',
    async () => {
      const { data: firmware, version: firmwareVersion } =
        await pickAlternateFirmware();

      let transport = openTransport();
      let client = new McuMgrClient(transport);

      try {
        const before = await client.imageList();
        console.log(`Version BEFORE upload: ${before.images[0].version}`);
        console.log(`Upload binary version: ${firmwareVersion}`);

        // Upload
        await client.imageUpload(firmware, {
          onProgress: (sent, total) => {
            const pct = Math.floor((sent * 100) / total);
            if (pct % 25 === 0) console.log(`Upload: ${sent}/${total} (${pct}%)`);
          },
        });

        // Mark for test swap
        const uploaded = await client.imageList();
        expect(uploaded.images.length).toBeGreaterThanOrEqual(2);
        const slot1Hash = uploaded.images[1].hash;
        expect(slot1Hash).toBeDefined();
        await client.imageTest(slot1Hash);
        console.log('Marked slot 1 for test swap');

        // Reset to trigger swap
        await client.reset();
        await transport.close();
      } catch (e) {
        await transport.close();
        throw e;
      }

      await waitForDeviceGone(vid, pid, 10_000);
      expect(await waitForDevice(vid, pid, 30_000)).toBe(true);

      // Allow USB stack to initialize
      await new Promise((r) => setTimeout(r, 2000));

      // Verify new image is running
      transport = openTransport();
      client = new McuMgrClient(transport);
      try {
        const after = await client.imageList();
        const slot0 = after.images[0];
        console.log(`Version AFTER swap: ${slot0.version}`);

        expect(slot0.active).toBe(true);
        expect(slot0.version.startsWith(firmwareVersion)).toBe(true);
      } finally {
        await transport.close();
      }
    },
    180_000,
  );

  test.skipIf(!config.testFirmwareBin)(
    'rollback on timeout',
    async () => {
      const testFirmware = new Uint8Array(readFileSync(config.testFirmwareBin!));

      // Upload non-confirming image
      let transport = openTransport();
      let client = new McuMgrClient(transport);
      let originalHash: Uint8Array;

      try {
        const original = await client.imageList();
        originalHash = original.images[0].hash;
        await client.imageUpload(testFirmware);
        await client.reset();
        await transport.close();
      } catch (e) {
        await transport.close();
        throw e;
      }

      await waitForDeviceGone(vid, pid, 10_000);
      expect(await waitForDevice(vid, pid, 30_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));

      // First boot: non-confirming image runs, force second reset
      transport = openTransport();
      client = new McuMgrClient(transport);
      try {
        await client.reset();
        await transport.close();
      } catch (e) {
        await transport.close();
        throw e;
      }

      await waitForDeviceGone(vid, pid, 10_000);
      expect(await waitForDevice(vid, pid, 30_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));

      // After second boot: MCUboot should have reverted
      transport = openTransport();
      client = new McuMgrClient(transport);
      try {
        const resp = await client.imageList();
        const slot0 = resp.images[0];
        expect(slot0.confirmed).toBe(true);

        // Compare hash arrays
        const currentHash = slot0.hash;
        expect(currentHash.length).toBe(originalHash!.length);
        for (let i = 0; i < currentHash.length; i++) {
          expect(currentHash[i]).toBe(originalHash![i]);
        }
      } finally {
        await transport.close();
      }
    },
    300_000,
  );
});
