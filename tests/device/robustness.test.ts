// Transport edge-case tests.

import { describe, expect, test } from 'vitest';
import { McuMgrClient } from '../../src/client.js';
import {
  SmpOp,
  SmpGroup,
  ImageCmd,
  SMP_HDR_SIZE,
  encodeHeader,
} from '../../src/smp.js';
import { config } from './helpers/device-config.js';
import { NodeHidTransport } from '../../src/node-hid.js';

const { vid, pid } = config;

const REPORT_ID_OUT = config.reportIdOut;
const PAYLOAD_SIZE = 62;

describe('transport robustness', () => {
  test('reassembly timeout: partial packet then valid request succeeds', async () => {
    const transport = new NodeHidTransport({
      vid,
      pid,
      reportIdOut: config.reportIdOut,
      reportIdIn: config.reportIdIn,
    });

    try {
      // Craft SMP header claiming 200-byte body (needs 2+ fragments)
      // but only send the first fragment → firmware will wait then timeout
      const fakeHdr = encodeHeader({
        op: SmpOp.Read,
        flags: 0,
        len: 200,
        group: SmpGroup.Image,
        seq: 99,
        id: ImageCmd.State,
      });

      // Build raw report: [reportId, length, smp_data..., zero_padding...]
      const report = new Uint8Array(1 + 1 + PAYLOAD_SIZE);
      report[0] = REPORT_ID_OUT;
      report[1] = fakeHdr.length;
      report.set(fakeHdr, 2);
      // Remaining bytes are 0 (padding)

      transport.rawWrite(report);

      // Wait past the 5s firmware reassembly timeout
      await new Promise((r) => setTimeout(r, 6000));

      // Now send a valid image_list — should succeed
      const client = new McuMgrClient(transport);
      const resp = await client.imageList();
      expect(resp.images.length).toBeGreaterThanOrEqual(1);
    } finally {
      await transport.close();
    }
  }, 15_000);

  test('rapid image_list: 10 consecutive calls all succeed', async () => {
    const transport = new NodeHidTransport({
      vid,
      pid,
      reportIdOut: config.reportIdOut,
      reportIdIn: config.reportIdIn,
    });
    const client = new McuMgrClient(transport);

    try {
      for (let i = 0; i < 10; i++) {
        const resp = await client.imageList();
        expect(resp.images.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await transport.close();
    }
  });
});
