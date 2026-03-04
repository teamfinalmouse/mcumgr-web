// McuMgrClient — all MCUmgr commands over any Transport.

import { Encoder } from 'cbor-x';

const cborEncoder = new Encoder({ useRecords: false, tagUint8Array: false });
import { McuMgrError } from './errors.js';
import { ImageCmd, OsCmd, SmpGroup, SmpOp } from './smp.js';
import type { Transport } from './transport.js';

// -- Response types --

export interface ImageStateEntry {
  image: number;
  slot: number;
  version: string;
  hash: Uint8Array;
  bootable: boolean;
  pending: boolean;
  confirmed: boolean;
  active: boolean;
  permanent: boolean;
}

export interface ImageStateResponse {
  images: ImageStateEntry[];
  splitStatus?: number;
}

export interface BootloaderInfoResponse {
  bootloader: string;
  mode?: number;
  noDowngrade?: boolean;
}

export interface TaskInfo {
  prio: number;
  state: number;
  stkuse: number;
  stksiz: number;
  cswcnt: number;
  runtime: number;
  last_checkin: number;
  next_checkin: number;
}

export interface TaskStatResponse {
  tasks: Record<string, TaskInfo>;
}

export interface McumgrParamsResponse {
  bufSize: number;
  bufCount: number;
}

export interface ImageUploadOptions {
  /** Image number (0 = primary image, default; 1 = secondary for multi-image). */
  image?: number;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export class McuMgrClient {
  constructor(private transport: Transport) {}

  // -- OS commands (from os.rs) --

  async echo(message: string): Promise<string> {
    const body = await this.command(SmpOp.Write, SmpGroup.Os, OsCmd.Echo, {
      d: message,
    });
    return body.r as string;
  }

  async reset(force?: number): Promise<void> {
    const req: Record<string, unknown> = {};
    if (force !== undefined) req.force = force;
    await this.command(SmpOp.Write, SmpGroup.Os, OsCmd.Reset, req);
  }

  async osInfo(format?: string): Promise<string> {
    const req: Record<string, unknown> = {};
    if (format !== undefined) req.format = format;
    const body = await this.command(SmpOp.Read, SmpGroup.Os, OsCmd.Info, req);
    return body.output as string;
  }

  async bootloaderInfo(query?: string): Promise<BootloaderInfoResponse> {
    const req: Record<string, unknown> = {};
    if (query !== undefined) req.query = query;
    const body = await this.command(
      SmpOp.Read,
      SmpGroup.Os,
      OsCmd.BootloaderInfo,
      req,
    );
    return {
      bootloader: body.bootloader as string,
      mode: body.mode as number | undefined,
      noDowngrade: body['no-downgrade'] as boolean | undefined,
    };
  }

  async taskstat(): Promise<TaskStatResponse> {
    const body = await this.command(
      SmpOp.Read,
      SmpGroup.Os,
      OsCmd.TaskStat,
    );
    return { tasks: body.tasks as Record<string, TaskInfo> };
  }

  async mcumgrParams(): Promise<McumgrParamsResponse> {
    const body = await this.command(
      SmpOp.Read,
      SmpGroup.Os,
      OsCmd.McumgrParams,
    );
    return {
      bufSize: body.buf_size as number,
      bufCount: body.buf_count as number,
    };
  }

  // -- Image commands (from image.rs) --

  async imageList(): Promise<ImageStateResponse> {
    const body = await this.command(
      SmpOp.Read,
      SmpGroup.Image,
      ImageCmd.State,
    );
    const rawImages = body.images as Array<Record<string, unknown>>;
    return {
      images: rawImages.map((img) => ({
        image: (img.image as number) ?? 0,
        slot: img.slot as number,
        version: img.version as string,
        hash: img.hash as Uint8Array,
        bootable: (img.bootable as boolean) ?? false,
        pending: (img.pending as boolean) ?? false,
        confirmed: (img.confirmed as boolean) ?? false,
        active: (img.active as boolean) ?? false,
        permanent: (img.permanent as boolean) ?? false,
      })),
      splitStatus: body.splitStatus as number | undefined,
    };
  }

  async imageUpload(
    data: Uint8Array,
    options?: ImageUploadOptions,
  ): Promise<void> {
    const image = options?.image ?? 0;
    const signal = options?.signal;

    // Compute SHA-256 using Web Crypto
    const hashBuf = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(data) as unknown as BufferSource,
    );
    const sha = new Uint8Array(hashBuf);

    const mtu = this.transport.mtu;
    let off = 0;

    while (off < data.length) {
      signal?.throwIfAborted();

      const chunkLen = Math.min(mtu, data.length - off);
      const chunk = data.subarray(off, off + chunkLen);

      const req: Record<string, unknown> = {
        image,
        off,
        data: chunk,
      };

      // First chunk includes total length and SHA
      if (off === 0) {
        req.len = data.length;
        req.sha = sha;
      }

      const body = await this.command(
        SmpOp.Write,
        SmpGroup.Image,
        ImageCmd.Upload,
        req,
      );

      const nextOff = body.off as number;
      if (nextOff <= off) {
        throw new McuMgrError(`Upload stalled: device offset ${nextOff} did not advance past ${off}`);
      }
      off = nextOff;

      options?.onProgress?.(Math.min(off, data.length), data.length);
    }
  }

  async imageTest(
    hash: Uint8Array,
    confirm?: boolean,
  ): Promise<void> {
    const req: Record<string, unknown> = { hash };
    if (confirm !== undefined) req.confirm = confirm;
    await this.command(SmpOp.Write, SmpGroup.Image, ImageCmd.State, req);
  }

  async imageErase(slot?: number): Promise<void> {
    const req: Record<string, unknown> = {};
    if (slot !== undefined) req.slot = slot;
    await this.command(SmpOp.Write, SmpGroup.Image, ImageCmd.Erase, req);
  }

  // -- Private helpers --

  private async command(
    op: SmpOp,
    group: SmpGroup,
    id: number,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const encoded = new Uint8Array(cborEncoder.encode(body ?? {}));
    const response = await this.transport.transceive(op, group, id, encoded);
    const rc = response.body.rc as number | undefined;
    if (rc !== undefined && rc !== 0) {
      throw new McuMgrError('Device error', rc);
    }
    return response.body;
  }
}
