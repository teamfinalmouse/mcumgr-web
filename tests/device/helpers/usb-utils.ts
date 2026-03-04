// USB device presence helpers.

import { execSync } from 'child_process';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Check if a USB device with given VID:PID is enumerated via lsusb. */
export async function isDevicePresent(vid: number, pid: number): Promise<boolean> {
  const vidPid = `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;
  try {
    const stdout = execSync(`lsusb -d ${vidPid}`, { timeout: 5000, encoding: 'utf-8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Wait until a USB device with given VID:PID appears. */
export async function waitForDevice(
  vid: number,
  pid: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDevicePresent(vid, pid)) return true;
    await sleep(500);
  }
  return false;
}

/** Wait until a USB device with given VID:PID disappears. */
export async function waitForDeviceGone(
  vid: number,
  pid: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDevicePresent(vid, pid))) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Parse MCUboot version from an image header.
 *
 * MCUboot header layout (first 28 bytes):
 *   magic(4) + load_addr(4) + hdr_size(2) + protect_tlv_size(2) +
 *   img_size(4) + flags(4) + ver_major(1) + ver_minor(1) + ver_rev(2) + ver_build(4)
 */
export function parseMcubootVersion(data: Uint8Array): string {
  if (data.length < 28) {
    throw new Error(`MCUboot header too short: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0x96f3b83d) {
    throw new Error(`Bad MCUboot magic: 0x${magic.toString(16).padStart(8, '0')}`);
  }
  const major = view.getUint8(20);
  const minor = view.getUint8(21);
  const rev = view.getUint16(22, true);
  return `${major}.${minor}.${rev}`;
}
