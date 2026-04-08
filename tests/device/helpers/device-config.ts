// Device configuration from environment variables with Finalmouse defaults.

function envInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (!val) return fallback;
  return parseInt(val, val.startsWith('0x') ? 16 : 10);
}

function envStr(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  /** USB Vendor ID */
  vid: envInt('MCUMGR_VID', 0x361d),
  /** USB Product ID (dongle app) */
  pid: envInt('MCUMGR_PID', 0x0300),
  /** HID OUT report ID */
  reportIdOut: envInt('MCUMGR_REPORT_ID_OUT', 3),
  /** HID IN report ID */
  reportIdIn: envInt('MCUMGR_REPORT_ID_IN', 4),
  /** Signed firmware binary path for upload tests */
  firmwareBin: envStr('MCUMGR_FIRMWARE_BIN'),
  /** Alternate firmware binary (different version) for swap tests */
  firmwareBinAlt: envStr('MCUMGR_FIRMWARE_BIN_ALT'),
  /** Non-confirming firmware binary path for rollback tests */
  testFirmwareBin: envStr('MCUMGR_TEST_FIRMWARE_BIN'),
} as const;
