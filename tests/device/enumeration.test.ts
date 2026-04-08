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

  test('has a vendor HID collection on usage page 0xff00 / usage 0x01', () => {
    const devices = HID.devices(vid, pid);
    const vendorHid = devices.find(
      (d) => d.usagePage === 0xff00 && d.usage === 0x01,
    );
    expect(vendorHid).toBeDefined();
    expect(vendorHid?.path).toBeTruthy();
  });

  test('manufacturer string is "Finalmouse"', () => {
    const devices = HID.devices(vid, pid);
    expect(devices.length).toBeGreaterThan(0);

    const mfr = devices[0].manufacturer;
    expect(mfr).toBe('Finalmouse');
  });
});
