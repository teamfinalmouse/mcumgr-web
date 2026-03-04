// USB enumeration tests.

import { describe, expect, test } from 'vitest';
import HID from 'node-hid';
import { config } from './helpers/device-config.js';
import { isDevicePresent } from './helpers/usb-utils.js';

describe('USB enumeration', () => {
  const { vid, pid } = config;

  test('device present via lsusb', async () => {
    const present = await isDevicePresent(vid, pid);
    expect(present).toBe(true);
  });

  test('has ≥2 HID interfaces (boot mouse 0 + vendor 1)', () => {
    const devices = HID.devices(vid, pid);
    expect(devices.length).toBeGreaterThanOrEqual(2);

    const ifaces = devices.map((d) => d.interface).sort();
    expect(ifaces).toContain(0); // boot mouse
    expect(ifaces).toContain(1); // vendor HID
  });

  test('manufacturer string is "Finalmouse"', () => {
    const devices = HID.devices(vid, pid);
    expect(devices.length).toBeGreaterThan(0);

    const mfr = devices[0].manufacturer;
    expect(mfr).toBe('Finalmouse');
  });
});
