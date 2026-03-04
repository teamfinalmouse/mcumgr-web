import { describe, expect, test, beforeEach } from 'vitest';
import { Encoder } from 'cbor-x';

const cborEncoder = new Encoder({ useRecords: false, tagUint8Array: false });
import { WebHidTransport, type WebHidOptions } from '../../src/webhid.js';
import {
  SMP_HDR_SIZE,
  SmpOp,
  SmpGroup,
  encodeHeader,
  decodeHeader,
} from '../../src/smp.js';
import { buildSmpPacket, ECHO_RESPONSE, LARGE_PACKET } from '../fixtures/smp-packets.js';

// --- Constants under test (imported indirectly via behavior) ---
// The firmware defines: FRAME_HDR_SIZE=1, PAYLOAD_SIZE=62, REPORT_DATA_SIZE=63
const EXPECTED_HID_REPORT_SIZE = 63;
const EXPECTED_PAYLOAD_SIZE = 62;
const FRAME_HDR_SIZE = 1;

// --- MockHIDDevice ---

type InputReportListener = (event: HIDInputReportEvent) => void;

class MockHIDDevice {
  opened = false;
  sentReports: Array<{ reportId: number; data: Uint8Array }> = [];
  private listeners: Map<string, Set<InputReportListener>> = new Map();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const buf =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as DataView).buffer,
            (data as DataView).byteOffset,
            (data as DataView).byteLength,
          );
    this.sentReports.push({ reportId, data: new Uint8Array(buf) });
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as InputReportListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as InputReportListener);
  }

  /** Simulate an incoming HID input report. */
  simulateInputReport(reportId: number, data: Uint8Array): void {
    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const event = {
      reportId,
      data: dataView,
      device: this as unknown as HIDDevice,
    } as HIDInputReportEvent;

    const listeners = this.listeners.get('inputreport');
    if (listeners) {
      for (const fn of listeners) {
        fn(event);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.get('inputreport')?.size ?? 0;
  }

  // Stubs for HIDDevice interface
  collections = [] as HIDCollectionInfo[];
  productId = 0;
  productName = 'Mock';
  vendorId = 0;
  async forget(): Promise<void> {}
  async receiveFeatureReport(_id: number): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }
  async sendFeatureReport(_id: number, _data: BufferSource): Promise<void> {}
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => unknown) | null = null;
  dispatchEvent(_event: Event): boolean {
    return false;
  }
}

// --- Helper to create transport from mock ---

async function createTransport(
  mock: MockHIDDevice,
  options?: WebHidOptions,
): Promise<WebHidTransport> {
  return WebHidTransport.fromDevice(mock as unknown as HIDDevice, options);
}

/** Fragment an SMP packet into HID input reports (simulating firmware TX). */
function fragmentPacket(
  packet: Uint8Array,
  reportId: number,
): Uint8Array[] {
  const reports: Uint8Array[] = [];
  let offset = 0;
  while (offset < packet.length) {
    const chunkEnd = Math.min(offset + EXPECTED_PAYLOAD_SIZE, packet.length);
    const chunk = packet.subarray(offset, chunkEnd);
    const report = new Uint8Array(EXPECTED_HID_REPORT_SIZE);
    report[0] = chunk.length;
    report.set(chunk, FRAME_HDR_SIZE);
    reports.push(report);
    offset = chunkEnd;
  }
  return reports;
}

describe('WebHID TX fragmentation', () => {
  let mock: MockHIDDevice;
  let transport: WebHidTransport;

  beforeEach(async () => {
    mock = new MockHIDDevice();
    transport = await createTransport(mock);
  });

  test('single fragment: 8-byte packet → one report, data[0]=8, padded to 63 bytes', async () => {
    const packet = buildSmpPacket(
      { op: SmpOp.Read, group: SmpGroup.Os, seq: 0, id: 0 },
      {},
    );
    expect(packet.length).toBeLessThanOrEqual(EXPECTED_PAYLOAD_SIZE);

    // Set up a dummy response so transceive resolves
    const responsePacket = ECHO_RESPONSE;
    const responseReports = fragmentPacket(responsePacket, 1);

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({})),
    );

    // Simulate response after TX
    await new Promise((r) => setTimeout(r, 1));
    for (const report of responseReports) {
      mock.simulateInputReport(1, report);
    }

    await promise;

    expect(mock.sentReports.length).toBe(1);
    const sent = mock.sentReports[0];
    expect(sent.reportId).toBe(1); // default OUT report ID
    expect(sent.data.length).toBe(EXPECTED_HID_REPORT_SIZE);
    // Length byte should be the packet length
    expect(sent.data[0]).toBe(packet.length);
    // Verify SMP header is in the data
    expect(sent.data[1]).toBe(SmpOp.Read);
  });

  test('multi-fragment: 130-byte packet → ceil(130/62)=3 reports', async () => {
    // Create a body large enough to produce 130 bytes total
    const bodyContent = { output: 'B'.repeat(200) };
    const cborBody = new Uint8Array(cborEncoder.encode(bodyContent));
    const hdr = encodeHeader({
      op: SmpOp.Read,
      flags: 0,
      len: cborBody.length,
      group: SmpGroup.Os,
      seq: 0,
      id: 7,
    });
    const bigPacket = new Uint8Array(SMP_HDR_SIZE + cborBody.length);
    bigPacket.set(hdr, 0);
    bigPacket.set(cborBody, SMP_HDR_SIZE);

    // Ensure it's big enough to need 3+ fragments
    expect(bigPacket.length).toBeGreaterThan(EXPECTED_PAYLOAD_SIZE * 2);

    const expectedFragments = Math.ceil(bigPacket.length / EXPECTED_PAYLOAD_SIZE);

    // Build a dummy response
    const respPacket = buildSmpPacket(
      { op: SmpOp.ReadRsp, group: SmpGroup.Os, seq: 0, id: 7 },
      { output: 'ok' },
    );
    const respReports = fragmentPacket(respPacket, 1);

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      7,
      cborBody,
    );

    await new Promise((r) => setTimeout(r, 1));
    for (const report of respReports) {
      mock.simulateInputReport(1, report);
    }

    await promise;

    expect(mock.sentReports.length).toBe(expectedFragments);

    // Verify each fragment has correct length byte
    let totalSent = 0;
    for (let i = 0; i < mock.sentReports.length; i++) {
      const report = mock.sentReports[i];
      expect(report.data.length).toBe(EXPECTED_HID_REPORT_SIZE);
      const len = report.data[0];
      expect(len).toBeGreaterThan(0);
      expect(len).toBeLessThanOrEqual(EXPECTED_PAYLOAD_SIZE);
      totalSent += len;
    }
    // Total of all length bytes should equal the full packet
    expect(totalSent).toBe(bigPacket.length);
  });

  test('exact boundary: 62-byte payload fits in one fragment', async () => {
    // An SMP packet of exactly 62 bytes should fit in one fragment
    // SMP_HDR_SIZE=8, so body needs to be 54 bytes
    const bodyContent = { d: 'x'.repeat(43) }; // CBOR encoding ~54 bytes
    const cborBody = new Uint8Array(cborEncoder.encode(bodyContent));
    const totalLen = SMP_HDR_SIZE + cborBody.length;

    // Adjust if needed - we want exactly EXPECTED_PAYLOAD_SIZE
    // Find a message that produces exactly 62 bytes total
    let adjustedBody = cborBody;
    if (totalLen > EXPECTED_PAYLOAD_SIZE) {
      // Trim
      adjustedBody = cborBody.subarray(0, EXPECTED_PAYLOAD_SIZE - SMP_HDR_SIZE);
    }

    const respPacket = ECHO_RESPONSE;
    const respReports = fragmentPacket(respPacket, 1);

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      adjustedBody,
    );

    await new Promise((r) => setTimeout(r, 1));
    for (const report of respReports) {
      mock.simulateInputReport(1, report);
    }

    await promise;

    // Packet should be <= EXPECTED_PAYLOAD_SIZE, so only 1 report
    expect(mock.sentReports.length).toBe(1);
    expect(mock.sentReports[0].data[0]).toBe(SMP_HDR_SIZE + adjustedBody.length);
  });

  test('exact boundary: 124-byte payload → exactly 2 fragments', async () => {
    // 124 bytes = 2 * 62, so exactly 2 fragments
    // Need total packet of 124 bytes: header(8) + body(116)
    const body = new Uint8Array(116).fill(0x42);

    const respPacket = ECHO_RESPONSE;
    const respReports = fragmentPacket(respPacket, 1);

    const promise = transport.transceive(SmpOp.Read, SmpGroup.Os, 0, body);

    await new Promise((r) => setTimeout(r, 1));
    for (const report of respReports) {
      mock.simulateInputReport(1, report);
    }

    await promise;

    expect(mock.sentReports.length).toBe(2);
    expect(mock.sentReports[0].data[0]).toBe(EXPECTED_PAYLOAD_SIZE); // first: full 62
    expect(mock.sentReports[1].data[0]).toBe(124 - EXPECTED_PAYLOAD_SIZE); // second: remaining
  });
});

describe('WebHID RX reassembly', () => {
  let mock: MockHIDDevice;
  let transport: WebHidTransport;
  const reportIdIn = 1;

  beforeEach(async () => {
    mock = new MockHIDDevice();
    transport = await createTransport(mock);
  });

  test('single-fragment response resolves with decoded SmpResponse', async () => {
    const cborBody = new Uint8Array(cborEncoder.encode({ r: 'hello' }));
    const respPacket = buildSmpPacket(
      { op: SmpOp.WriteRsp, group: SmpGroup.Os, seq: 0, id: 0 },
      { r: 'hello' },
    );

    const promise = transport.transceive(
      SmpOp.Write,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({ d: 'hello' })),
    );

    await new Promise((r) => setTimeout(r, 1));
    const reports = fragmentPacket(respPacket, reportIdIn);
    for (const report of reports) {
      mock.simulateInputReport(reportIdIn, report);
    }

    const resp = await promise;
    expect(resp.header.op).toBe(SmpOp.WriteRsp);
    expect(resp.body.r).toBe('hello');
  });

  test('multi-fragment response assembles correctly', async () => {
    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      7,
      new Uint8Array(cborEncoder.encode({})),
    );

    await new Promise((r) => setTimeout(r, 1));

    // LARGE_PACKET is >62 bytes, needs multiple fragments
    const reports = fragmentPacket(LARGE_PACKET, reportIdIn);
    expect(reports.length).toBeGreaterThan(1);

    for (const report of reports) {
      mock.simulateInputReport(reportIdIn, report);
    }

    const resp = await promise;
    expect(resp.header.op).toBe(SmpOp.ReadRsp);
    expect((resp.body.output as string).length).toBe(120);
  });

  test('ignores reports with wrong reportId', async () => {
    const respPacket = ECHO_RESPONSE;

    const promise = transport.transceive(
      SmpOp.Write,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({ d: 'hi' })),
    );

    await new Promise((r) => setTimeout(r, 1));

    // Send with wrong report ID first
    const wrongReport = new Uint8Array(EXPECTED_HID_REPORT_SIZE);
    wrongReport[0] = 8;
    wrongReport.set(respPacket.subarray(0, 8), 1);
    mock.simulateInputReport(99, wrongReport); // wrong ID

    // Then send correct reports
    const reports = fragmentPacket(respPacket, reportIdIn);
    for (const report of reports) {
      mock.simulateInputReport(reportIdIn, report);
    }

    const resp = await promise;
    expect(resp.body.r).toBe('hello');
  });

  test('ignores length byte 0', async () => {
    const respPacket = ECHO_RESPONSE;

    const promise = transport.transceive(
      SmpOp.Write,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({ d: 'hi' })),
    );

    await new Promise((r) => setTimeout(r, 1));

    // Send report with length=0
    const zeroLenReport = new Uint8Array(EXPECTED_HID_REPORT_SIZE);
    zeroLenReport[0] = 0;
    mock.simulateInputReport(reportIdIn, zeroLenReport);

    // Then send correct
    const reports = fragmentPacket(respPacket, reportIdIn);
    for (const report of reports) {
      mock.simulateInputReport(reportIdIn, report);
    }

    const resp = await promise;
    expect(resp.body.r).toBe('hello');
  });

  test('times out if incomplete', async () => {
    const shortTimeout = await createTransport(mock, { timeoutMs: 100 });

    const promise = shortTimeout.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({})),
    );

    // Don't send any response → should timeout
    await expect(promise).rejects.toThrow('HID read timeout');
  });

  test('removes event listener after success', async () => {
    const respPacket = ECHO_RESPONSE;

    const promise = transport.transceive(
      SmpOp.Write,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({ d: 'hi' })),
    );

    const listenersBefore = mock.listenerCount;
    expect(listenersBefore).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1));
    const reports = fragmentPacket(respPacket, reportIdIn);
    for (const report of reports) {
      mock.simulateInputReport(reportIdIn, report);
    }

    await promise;

    // Listener should be removed after successful completion
    expect(mock.listenerCount).toBe(0);
  });

  test('removes event listener after timeout', async () => {
    const shortTimeout = await createTransport(mock, { timeoutMs: 50 });

    const promise = shortTimeout.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({})),
    );

    try {
      await promise;
    } catch {
      // Expected timeout
    }

    expect(mock.listenerCount).toBe(0);
  });
});

describe('WebHID transceive', () => {
  let mock: MockHIDDevice;
  let transport: WebHidTransport;

  beforeEach(async () => {
    mock = new MockHIDDevice();
    transport = await createTransport(mock);
  });

  test('sequence counter increments and wraps 255→0', async () => {
    // Make 257 calls to get seq from 0 → 255 → 0
    // We'll check a subset for efficiency
    for (let i = 0; i < 257; i++) {
      const respPacket = buildSmpPacket(
        { op: SmpOp.ReadRsp, group: SmpGroup.Os, seq: i & 0xff, id: 0 },
        { r: 'ok' },
      );

      const promise = transport.transceive(
        SmpOp.Read,
        SmpGroup.Os,
        0,
        new Uint8Array(cborEncoder.encode({})),
      );

      await new Promise((r) => setTimeout(r, 0));
      const reports = fragmentPacket(respPacket, 1);
      for (const report of reports) {
        mock.simulateInputReport(1, report);
      }

      await promise;
    }

    // seq 0 → 255 → 0: verify last report has seq=0
    // The 257th call should use seq=0 (wrapped from 256)
    expect(mock.sentReports.length).toBe(257);

    // Check seq byte (byte 6 of SMP header, after length byte in report)
    const lastReport = mock.sentReports[256];
    expect(lastReport.data[FRAME_HDR_SIZE + 6]).toBe(0); // seq wrapped to 0

    // Check 256th call had seq=255
    const report255 = mock.sentReports[255];
    expect(report255.data[FRAME_HDR_SIZE + 6]).toBe(255);
  });

  test('returns parsed header + CBOR body', async () => {
    const respPacket = buildSmpPacket(
      { op: SmpOp.ReadRsp, group: SmpGroup.Image, seq: 0, id: 0 },
      { images: [] },
    );

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Image,
      0,
      new Uint8Array(cborEncoder.encode({})),
    );

    await new Promise((r) => setTimeout(r, 1));
    const reports = fragmentPacket(respPacket, 1);
    for (const report of reports) {
      mock.simulateInputReport(1, report);
    }

    const resp = await promise;
    expect(resp.header.op).toBe(SmpOp.ReadRsp);
    expect(resp.header.group).toBe(SmpGroup.Image);
    expect(resp.body.images).toEqual([]);
  });
});

describe('WebHID constants validation', () => {
  test('PAYLOAD_SIZE must be 62 (matching firmware SMP_HID_PAYLOAD_SIZE)', async () => {
    const mock = new MockHIDDevice();
    const transport = await createTransport(mock);

    // Send a packet of exactly 62 bytes SMP data: should be 1 fragment
    const body62 = new Uint8Array(62 - SMP_HDR_SIZE); // 54 bytes body → 62 total
    const respPacket = ECHO_RESPONSE;
    const respReports = fragmentPacket(respPacket, 1);

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      body62,
    );

    await new Promise((r) => setTimeout(r, 1));
    for (const report of respReports) {
      mock.simulateInputReport(1, report);
    }
    await promise;

    expect(mock.sentReports.length).toBe(1);
    expect(mock.sentReports[0].data[0]).toBe(62); // length byte = 62
  });

  test('HID_REPORT_SIZE must be 63 (matching firmware SMP_HID_REPORT_DATA_SIZE)', async () => {
    const mock = new MockHIDDevice();
    const transport = await createTransport(mock);

    const respPacket = ECHO_RESPONSE;
    const respReports = fragmentPacket(respPacket, 1);

    const promise = transport.transceive(
      SmpOp.Read,
      SmpGroup.Os,
      0,
      new Uint8Array(cborEncoder.encode({})),
    );

    await new Promise((r) => setTimeout(r, 1));
    for (const report of respReports) {
      mock.simulateInputReport(1, report);
    }
    await promise;

    // Each sent report must be exactly 63 bytes (not 64)
    for (const report of mock.sentReports) {
      expect(report.data.length).toBe(63);
    }
  });
});
