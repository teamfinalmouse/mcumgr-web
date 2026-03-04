// MCUmgr DFU operations over USB HID.

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { McuMgrClient } from '../../src/client.js';
import { config } from './helpers/device-config.js';
import { NodeHidTransport } from './helpers/node-hid-transport.js';
import { pickAlternateFirmware } from './helpers/firmware-picker.js';
import { waitForDevice, waitForDeviceGone } from './helpers/usb-utils.js';

const { vid, pid } = config;

function openTransport(): NodeHidTransport {
  return new NodeHidTransport({
    vid,
    pid,
    iface: config.iface,
    reportIdOut: config.reportIdOut,
    reportIdIn: config.reportIdIn,
  });
}

describe('image list', () => {
  let transport: NodeHidTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    transport = openTransport();
    client = new McuMgrClient(transport);
  });

  afterEach(async () => {
    await transport.close();
  });

  test('returns images array with ≥1 entry', async () => {
    const resp = await client.imageList();
    expect(resp.images.length).toBeGreaterThanOrEqual(1);
  });

  test('slot 0 is active and confirmed', async () => {
    const resp = await client.imageList();
    const slot0 = resp.images[0];
    expect(slot0.active).toBe(true);
    expect(slot0.confirmed).toBe(true);
  });

  test('primary image version matches d+.d+.d+', async () => {
    const resp = await client.imageList();
    const version = resp.images[0].version;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

const hasTwoBinaries = !!config.firmwareBin && !!config.firmwareBinAlt;

describe.skipIf(!hasTwoBinaries)('image upload', () => {
  let transport: NodeHidTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    transport = openTransport();
    client = new McuMgrClient(transport);
  });

  afterEach(async () => {
    await transport.close();
  });

  test(
    'upload firmware with progress, verify slot 1 pending',
    async () => {
      const { data: firmware } = await pickAlternateFirmware();
      const progress: Array<[number, number]> = [];

      await client.imageUpload(firmware, {
        onProgress: (sent, total) => {
          progress.push([sent, total]);
          const pct = Math.floor((sent * 100) / total);
          if (pct % 25 === 0) {
            console.log(`Upload: ${sent} / ${total} bytes (${pct}%)`);
          }
        },
      });
      expect(progress.length).toBeGreaterThan(0);

      const resp = await client.imageList();
      expect(resp.images.length).toBeGreaterThanOrEqual(2);

      const slot1 = resp.images[1];
      expect(slot1.pending || !slot1.confirmed).toBe(true);
    },
    120_000,
  );

  test(
    'upload → test → reset → device re-enumerates within 30s',
    async () => {
      const { data: firmware } = await pickAlternateFirmware();

      await client.imageUpload(firmware, {
        onProgress: (sent, total) => {
          const pct = Math.floor((sent * 100) / total);
          if (pct % 25 === 0) {
            console.log(`Upload: ${sent} / ${total} bytes (${pct}%)`);
          }
        },
      });

      const resp = await client.imageList();
      expect(resp.images.length).toBeGreaterThanOrEqual(2);
      const slot1Hash = resp.images[1].hash;
      await client.imageTest(slot1Hash);

      await client.reset();
      await transport.close();

      const gone = await waitForDeviceGone(vid, pid, 10_000);
      expect(gone).toBe(true);

      const found = await waitForDevice(vid, pid, 30_000);
      expect(found).toBe(true);
    },
    120_000,
  );
});
