// Picks a firmware binary whose version differs from the running device image.

import { readFileSync } from 'fs';
import { McuMgrClient } from '../../../src/client.js';
import { config } from './device-config.js';
import { NodeHidTransport } from '../../../src/node-hid.js';
import { parseMcubootVersion } from './usb-utils.js';

function openTransport(): NodeHidTransport {
  return new NodeHidTransport({
    vid: config.vid,
    pid: config.pid,
    reportIdOut: config.reportIdOut,
    reportIdIn: config.reportIdIn,
  });
}

/**
 * Pick a firmware binary whose MCUboot version differs from the running device.
 * Checks MCUMGR_FIRMWARE_BIN and MCUMGR_FIRMWARE_BIN_ALT, queries the device,
 * and returns whichever binary has a different version.
 */
export async function pickAlternateFirmware(): Promise<{
  data: Uint8Array;
  version: string;
}> {
  const bins = [config.firmwareBin, config.firmwareBinAlt].filter(
    Boolean,
  ) as string[];
  if (bins.length < 2) {
    throw new Error(
      'Swap tests require two different firmware binaries: ' +
        'set both MCUMGR_FIRMWARE_BIN and MCUMGR_FIRMWARE_BIN_ALT',
    );
  }

  // Query running version
  const transport = openTransport();
  const client = new McuMgrClient(transport);
  let runningVersion: string;
  try {
    const resp = await client.imageList();
    runningVersion = resp.images[0].version;
  } finally {
    await transport.close();
  }

  // Pick whichever binary has a different version
  for (const path of bins) {
    const data = new Uint8Array(readFileSync(path));
    const ver = parseMcubootVersion(data);
    if (!runningVersion.startsWith(ver)) {
      return { data, version: ver };
    }
  }

  throw new Error(
    `Both binaries match the running version ${runningVersion}. ` +
      'Provide two binaries with different versions.',
  );
}
