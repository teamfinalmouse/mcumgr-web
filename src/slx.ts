import { McuMgrClient } from './client.js';
import { McuMgrError } from './errors.js';
import { WebHidTransport, type WebHidOptions } from './webhid.js';

export const SLX_VENDOR_ID = 0x361d;
export const SLX_PRODUCT_ID = 0x0300;
export const SLX_USAGE_PAGE = 0xff00;
export const SLX_USAGE = 0x01;
export const SLX_REPORT_ID_OUT = 0x03;
export const SLX_REPORT_ID_IN = 0x04;

const DEFAULT_RECONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface SlxDeviceFilter extends HIDDeviceFilter {
  vendorId: number;
  productId: number;
  usagePage: number;
  usage: number;
}

export interface SlxUpdaterOptions extends WebHidOptions {
  reconnectTimeoutMs?: number;
  reconnectPollIntervalMs?: number;
}

export interface SlxFirmwareUpdateOptions {
  expectedVersion?: string;
  currentVersion?: string;
  onProgress?: (sent: number, total: number) => void;
  onPhaseChange?: (phase: SlxFirmwareUpdatePhase) => void;
  resolveVersion?: (device: HIDDevice) => Promise<string>;
  signal?: AbortSignal;
  reconnectTimeoutMs?: number;
}

export type SlxFirmwareUpdatePhase = 'uploading' | 'rebooting' | 'verifying';

export interface SlxFirmwareUpdateResult {
  previousVersion: string;
  currentVersion: string;
  device: HIDDevice;
}

export function getSlxDeviceFilters(): SlxDeviceFilter[] {
  return [
    {
      vendorId: SLX_VENDOR_ID,
      productId: SLX_PRODUCT_ID,
      usagePage: SLX_USAGE_PAGE,
      usage: SLX_USAGE,
    },
  ];
}

export function isSlxMcuMgrDevice(device: HIDDevice): boolean {
  return (
    device.vendorId === SLX_VENDOR_ID &&
    device.productId === SLX_PRODUCT_ID &&
    device.collections.some(
      (collection) =>
        collection.usagePage === SLX_USAGE_PAGE &&
        collection.usage === SLX_USAGE,
    )
  );
}

export async function getGrantedSlxDevices(): Promise<HIDDevice[]> {
  const devices = await navigator.hid.getDevices();
  return devices.filter(isSlxMcuMgrDevice);
}

export async function requestSlxDevice(): Promise<HIDDevice | null> {
  const devices = await navigator.hid.requestDevice({
    filters: getSlxDeviceFilters(),
  });
  return devices[0] ?? null;
}

export class SlxFirmwareUpdater {
  private device: HIDDevice;
  private transportOptions: WebHidOptions;
  private reconnectTimeoutMs: number;
  private reconnectPollIntervalMs: number;

  constructor(device: HIDDevice, options?: SlxUpdaterOptions) {
    if (!isSlxMcuMgrDevice(device)) {
      throw new McuMgrError('The provided HID device is not an SLX MCUmgr HID device');
    }

    this.device = device;
    this.transportOptions = {
      reportIdOut: options?.reportIdOut ?? SLX_REPORT_ID_OUT,
      reportIdIn: options?.reportIdIn ?? SLX_REPORT_ID_IN,
      ...options,
      closeDeviceOnClose: false,
    };
    this.reconnectTimeoutMs =
      options?.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    this.reconnectPollIntervalMs =
      options?.reconnectPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  getCurrentDevice(): HIDDevice {
    return this.device;
  }

  async getCurrentVersion(): Promise<string> {
    const state = await this.readImageState(this.device);
    if (state.images.length === 0) {
      throw new McuMgrError('Device did not report any image slots');
    }
    return state.images[0].version;
  }

  async updateFirmware(
    firmware: Uint8Array,
    options?: SlxFirmwareUpdateOptions,
  ): Promise<SlxFirmwareUpdateResult> {
    const previousVersion = options?.currentVersion ?? '';
    const transport = await WebHidTransport.fromDevice(
      this.device,
      this.transportOptions,
    );
    const client = new McuMgrClient(transport);

    try {
      options?.onPhaseChange?.('uploading');
      await client.imageUpload(firmware, {
        onProgress: options?.onProgress,
        signal: options?.signal,
      });

      await client.imageTest(await computeImageHash(firmware));
      options?.onPhaseChange?.('rebooting');
      await client.reset();
    } finally {
      await transport.close();
    }

    this.device = await this.waitForReconnect(
      options?.reconnectTimeoutMs ?? this.reconnectTimeoutMs,
      options?.signal,
    );

    options?.onPhaseChange?.('verifying');
    const currentVersion = options?.resolveVersion
      ? await options.resolveVersion(this.device)
      : options?.expectedVersion ?? previousVersion;
    if (
      options?.expectedVersion !== undefined &&
      !currentVersion.startsWith(options.expectedVersion)
    ) {
      throw new McuMgrError(
        `Firmware version mismatch after update: expected ${options.expectedVersion}, got ${currentVersion}`,
      );
    }

    return {
      previousVersion,
      currentVersion,
      device: this.device,
    };
  }

  private async readImageState(device: HIDDevice) {
    const transport = await WebHidTransport.fromDevice(
      device,
      this.transportOptions,
    );
    try {
      return await new McuMgrClient(transport).imageList();
    } finally {
      await transport.close();
    }
  }

  private async waitForReconnect(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HIDDevice> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();

      const devices = await getGrantedSlxDevices();
      const device = devices[0];
      if (device) {
        return device;
      }

      await delay(this.reconnectPollIntervalMs, signal);
    }

    throw new McuMgrError(
      `Timed out waiting ${timeoutMs}ms for the SLX device to reconnect`,
    );
  }
}

async function computeImageHash(data: Uint8Array): Promise<Uint8Array> {
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(data) as unknown as BufferSource,
  );
  return new Uint8Array(hashBuf);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
