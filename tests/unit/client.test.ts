import { describe, expect, test, beforeEach } from 'vitest';
import { decode } from 'cbor-x';
import { McuMgrClient } from '../../src/client.js';
import { McuMgrError } from '../../src/errors.js';
import {
  SmpOp,
  SmpGroup,
  OsCmd,
  ImageCmd,
  SMP_HDR_SIZE,
  decodeHeader,
  type SmpResponse,
} from '../../src/smp.js';
import type { Transport } from '../../src/transport.js';

// --- MockTransport ---

interface RecordedCall {
  op: SmpOp;
  group: SmpGroup;
  id: number;
  body: Record<string, unknown>;
}

class MockTransport implements Transport {
  calls: RecordedCall[] = [];
  private responses: Array<Record<string, unknown>> = [];
  readonly mtu = 2048;

  /** Queue a response body (CBOR-decoded) for the next transceive call. */
  queueResponse(body: Record<string, unknown>): void {
    this.responses.push(body);
  }

  async transceive(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body: Uint8Array,
  ): Promise<SmpResponse> {
    const decoded = decode(body) as Record<string, unknown>;
    this.calls.push({ op, group, id, body: decoded });

    const responseBody = this.responses.shift();
    if (!responseBody) {
      throw new Error('MockTransport: no response queued');
    }

    return {
      header: {
        op: (op + 1) as SmpOp, // Read→ReadRsp, Write→WriteRsp
        flags: 0,
        len: 0,
        group,
        seq: 0,
        id,
      },
      body: responseBody,
    };
  }

  async close(): Promise<void> {}
}

describe('McuMgrClient echo', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('sends Write/Os/Echo with {d: msg}, returns r field', async () => {
    mock.queueResponse({ r: 'hello' });
    const result = await client.echo('hello');

    expect(result).toBe('hello');
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].op).toBe(SmpOp.Write);
    expect(mock.calls[0].group).toBe(SmpGroup.Os);
    expect(mock.calls[0].id).toBe(OsCmd.Echo);
    expect(mock.calls[0].body).toEqual({ d: 'hello' });
  });
});

describe('McuMgrClient reset', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('sends Write/Os/Reset', async () => {
    mock.queueResponse({});
    await client.reset();

    expect(mock.calls[0].op).toBe(SmpOp.Write);
    expect(mock.calls[0].group).toBe(SmpGroup.Os);
    expect(mock.calls[0].id).toBe(OsCmd.Reset);
  });

  test('includes force only when provided', async () => {
    mock.queueResponse({});
    await client.reset(1);
    expect(mock.calls[0].body).toEqual({ force: 1 });

    mock.queueResponse({});
    await client.reset();
    expect(mock.calls[1].body).toEqual({});
  });
});

describe('McuMgrClient osInfo', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('sends Read/Os/Info, returns output', async () => {
    mock.queueResponse({ output: 'Zephyr 3.7' });
    const result = await client.osInfo();

    expect(result).toBe('Zephyr 3.7');
    expect(mock.calls[0].op).toBe(SmpOp.Read);
    expect(mock.calls[0].id).toBe(OsCmd.Info);
  });

  test('includes format only when provided', async () => {
    mock.queueResponse({ output: '{}' });
    await client.osInfo('json');
    expect(mock.calls[0].body).toEqual({ format: 'json' });

    mock.queueResponse({ output: '' });
    await client.osInfo();
    expect(mock.calls[1].body).toEqual({});
  });
});

describe('McuMgrClient bootloaderInfo', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('maps no-downgrade key to noDowngrade', async () => {
    mock.queueResponse({
      bootloader: 'MCUboot',
      mode: 0,
      'no-downgrade': true,
    });
    const result = await client.bootloaderInfo();

    expect(result.bootloader).toBe('MCUboot');
    expect(result.mode).toBe(0);
    expect(result.noDowngrade).toBe(true);
  });
});

describe('McuMgrClient taskstat', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('returns tasks record', async () => {
    const tasks = {
      main: {
        prio: 0,
        state: 1,
        stkuse: 512,
        stksiz: 2048,
        cswcnt: 100,
        runtime: 5000,
        last_checkin: 0,
        next_checkin: 0,
      },
    };
    mock.queueResponse({ tasks });
    const result = await client.taskstat();

    expect(result.tasks).toEqual(tasks);
    expect(mock.calls[0].op).toBe(SmpOp.Read);
    expect(mock.calls[0].id).toBe(OsCmd.TaskStat);
  });
});

describe('McuMgrClient mcumgrParams', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('returns bufSize/bufCount', async () => {
    mock.queueResponse({ buf_size: 2048, buf_count: 4 });
    const result = await client.mcumgrParams();

    expect(result.bufSize).toBe(2048);
    expect(result.bufCount).toBe(4);
    expect(mock.calls[0].op).toBe(SmpOp.Read);
    expect(mock.calls[0].id).toBe(OsCmd.McumgrParams);
  });
});

describe('McuMgrClient imageList', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('maps all image state fields, defaults missing booleans to false', async () => {
    mock.queueResponse({
      images: [
        {
          image: 0,
          slot: 0,
          version: '1.2.3',
          hash: new Uint8Array(32).fill(0xaa),
          bootable: true,
          active: true,
          confirmed: true,
          // pending, permanent missing → should default to false
        },
        {
          slot: 1,
          version: '1.2.4',
          hash: new Uint8Array(32).fill(0xbb),
          pending: true,
          // image missing → should default to 0
          // bootable, active, confirmed, permanent missing → false
        },
      ],
    });

    const result = await client.imageList();

    expect(result.images.length).toBe(2);

    const slot0 = result.images[0];
    expect(slot0.image).toBe(0);
    expect(slot0.slot).toBe(0);
    expect(slot0.version).toBe('1.2.3');
    expect(slot0.bootable).toBe(true);
    expect(slot0.active).toBe(true);
    expect(slot0.confirmed).toBe(true);
    expect(slot0.pending).toBe(false);
    expect(slot0.permanent).toBe(false);

    const slot1 = result.images[1];
    expect(slot1.image).toBe(0); // defaulted
    expect(slot1.slot).toBe(1);
    expect(slot1.pending).toBe(true);
    expect(slot1.bootable).toBe(false);
    expect(slot1.active).toBe(false);
    expect(slot1.confirmed).toBe(false);

    expect(mock.calls[0].op).toBe(SmpOp.Read);
    expect(mock.calls[0].group).toBe(SmpGroup.Image);
    expect(mock.calls[0].id).toBe(ImageCmd.State);
  });
});

describe('McuMgrClient imageUpload', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('first chunk has len/sha/image, subsequent have off/data', async () => {
    const firmware = new Uint8Array(4096).fill(0x42);

    // Queue responses that advance the offset
    let nextOff = 0;
    const chunkSize = mock.mtu;
    while (nextOff < firmware.length) {
      nextOff = Math.min(nextOff + chunkSize, firmware.length);
      mock.queueResponse({ off: nextOff });
    }

    await client.imageUpload(firmware);

    expect(mock.calls.length).toBeGreaterThanOrEqual(2);

    // First call
    const first = mock.calls[0];
    expect(first.op).toBe(SmpOp.Write);
    expect(first.group).toBe(SmpGroup.Image);
    expect(first.id).toBe(ImageCmd.Upload);
    expect(first.body.len).toBe(4096);
    expect(first.body.sha).toBeDefined();
    expect(first.body.image).toBe(0); // default image number
    expect(first.body.off).toBe(0);
    expect(first.body.data).toBeDefined();

    // Subsequent calls
    for (let i = 1; i < mock.calls.length; i++) {
      const call = mock.calls[i];
      expect(call.body.off).toBeGreaterThan(0);
      expect(call.body.data).toBeDefined();
      // Should NOT have len/sha on subsequent chunks
      expect(call.body.len).toBeUndefined();
      expect(call.body.sha).toBeUndefined();
    }
  });

  test('calls onProgress', async () => {
    const firmware = new Uint8Array(4096).fill(0x42);
    const progress: Array<[number, number]> = [];

    let nextOff = 0;
    while (nextOff < firmware.length) {
      nextOff = Math.min(nextOff + mock.mtu, firmware.length);
      mock.queueResponse({ off: nextOff });
    }

    await client.imageUpload(firmware, {
      onProgress: (sent, total) => progress.push([sent, total]),
    });

    expect(progress.length).toBeGreaterThan(0);
    // Last progress should show complete
    const last = progress[progress.length - 1];
    expect(last[0]).toBe(firmware.length);
    expect(last[1]).toBe(firmware.length);
  });

  test('respects AbortSignal', async () => {
    const firmware = new Uint8Array(8192).fill(0x42);
    const controller = new AbortController();

    // Queue one response then abort
    mock.queueResponse({ off: mock.mtu });
    controller.abort();

    await expect(
      client.imageUpload(firmware, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  test('throws if offset does not advance', async () => {
    const firmware = new Uint8Array(4096).fill(0x42);

    // Return same offset → stall
    mock.queueResponse({ off: 0 });

    await expect(client.imageUpload(firmware)).rejects.toThrow(
      'Upload stalled',
    );
  });
});

describe('McuMgrClient imageTest', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('sends hash, includes confirm when provided', async () => {
    const hash = new Uint8Array(32).fill(0xaa);

    mock.queueResponse({
      images: [
        { slot: 0, version: '1.0.0', hash, active: true, confirmed: true },
      ],
    });
    await client.imageTest(hash);
    expect(mock.calls[0].body.hash).toBeDefined();
    expect(mock.calls[0].body.confirm).toBeUndefined();

    mock.queueResponse({
      images: [
        { slot: 0, version: '1.0.0', hash, active: true, confirmed: true },
      ],
    });
    await client.imageTest(hash, true);
    expect(mock.calls[1].body.confirm).toBe(true);
  });
});

describe('McuMgrClient imageErase', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('sends slot when provided', async () => {
    mock.queueResponse({});
    await client.imageErase();
    expect(mock.calls[0].body).toEqual({});

    mock.queueResponse({});
    await client.imageErase(1);
    expect(mock.calls[1].body).toEqual({ slot: 1 });
  });
});

describe('McuMgrClient error handling', () => {
  let mock: MockTransport;
  let client: McuMgrClient;

  beforeEach(() => {
    mock = new MockTransport();
    client = new McuMgrClient(mock);
  });

  test('throws McuMgrError when rc≠0', async () => {
    mock.queueResponse({ rc: 3 });

    try {
      await client.echo('test');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(McuMgrError);
      expect((e as McuMgrError).rc).toBe(3);
    }
  });

  test('does not throw when rc=0', async () => {
    mock.queueResponse({ rc: 0, r: 'ok' });
    const result = await client.echo('test');
    expect(result).toBe('ok');
  });

  test('does not throw when rc absent', async () => {
    mock.queueResponse({ r: 'ok' });
    const result = await client.echo('test');
    expect(result).toBe('ok');
  });
});
