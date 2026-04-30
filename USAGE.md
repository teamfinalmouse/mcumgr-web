# mcumgr-web — Library Usage

How to upload, install, reboot, and confirm a firmware image on an SLX MCUmgr device using the bundled library (`dist/mcumgr-web.js` ESM or `dist/mcumgr-web.iife.js` IIFE).

Two transports are supported:

- **WebHID** — application firmware exposing the MCUmgr HID collection (running app, vendor HID).
- **Web Serial** — MCUboot **serial recovery** mode (USB CDC-ACM). Used to recover a device that's stuck in bootloader, or to reflash without an app-level MCUmgr.

The Node flow is identical except for the transport (`NodeHidTransport` / `NodeSerialTransport`).

## What's in the bundle

The default ESM bundle exports:

- `McuMgrClient` — generic MCUmgr command wrapper (echo, info, image list/upload/test/erase, reset, …).
- `WebHidTransport` — HID transport for browsers.
- `WebSerialTransport` — Web Serial transport for MCUboot serial recovery.
- `SlxFirmwareUpdater` — high-level helper (HID): upload + test + reset + reconnect + verify in one call.
- Helpers: `requestSlxDevice()`, `getGrantedSlxDevices()`, `getSlxDeviceFilters()`, `isSlxMcuMgrDevice()`.
- IDs: `SLX_VENDOR_ID` (`0x361d`), `SLX_PRODUCT_ID` (`0x0300`), report IDs, usage tuple.
- `McuMgrError` — thrown on transport / device errors. `.rc` carries the device return code if any.
- Serial framing primitives: `encodeSerialFrame`, `SerialFrameParser`, `crc16Xmodem`, `DEFAULT_LINELENGTH`.

## Prerequisites

- Browser with WebHID + Web Serial (Chrome/Edge desktop). Page served over HTTPS or `localhost`.
- For HID: device exposes the SLX MCUmgr HID collection (usage page `0xFF00`, usage `0x01`).
- For serial recovery: device enumerates as USB CDC-ACM in MCUboot recovery mode.

## Pick the right path

| You want to… | Use |
|---|---|
| Drop-in firmware update on an SLX dongle/mouse (running app) | `SlxFirmwareUpdater` (HID) |
| Custom flow / non-SLX device / individual commands | `McuMgrClient` + `WebHidTransport` |
| Recover a bricked device via MCUboot serial recovery | `McuMgrClient` + `WebSerialTransport` |

---

## Path A — High-level: `SlxFirmwareUpdater`

```html
<script type="module">
  import {
    requestSlxDevice,
    SlxFirmwareUpdater,
  } from './dist/mcumgr-web.js';

  document.querySelector('#flash').addEventListener('click', async () => {
    // 1. User gesture → pick HID device. Returns null if dialog cancelled.
    const device = await requestSlxDevice();
    if (!device) return;

    // 2. Load firmware bytes (zephyr.signed.bin).
    const firmware = new Uint8Array(
      await (await fetch('zephyr.signed.bin')).arrayBuffer(),
    );

    // 3. Run the full update.
    const updater = new SlxFirmwareUpdater(device);
    const result = await updater.updateFirmware(firmware, {
      expectedVersion: '0.3.0',     // optional sanity check after reboot
      onPhaseChange: (p) => console.log('phase:', p),    // 'uploading' | 'rebooting' | 'verifying'
      onProgress: (sent, total) => console.log(`${sent}/${total}`),
    });

    console.log('Now running:', result.currentVersion);
  });
</script>
```

What it does internally:

1. Open WebHID transport on the chosen device.
2. `imageUpload(firmware)` — chunks bytes (default MTU 512), first chunk carries `len` + SHA.
3. `imageList()` → pick non-active slot → `imageTest(hash)` → MCUboot is queued to swap-and-test on next boot.
4. `reset()` — device reboots; MCUboot runs the new image.
5. Polls `navigator.hid.getDevices()` until the device reappears (default 30 s).
6. Optionally calls `resolveVersion(device)` or returns `expectedVersion`.

Notes on `expectedVersion`: it's compared with `String.startsWith`. If you want a definitive check, supply `resolveVersion` to read the running image's version yourself (e.g. via a custom HID report or by reopening MCUmgr and reading `imageList()[0].version`).

---

## Path B — Low-level: `McuMgrClient` + `WebHidTransport`

Use this if you want to:

- Erase a slot before upload.
- Confirm an image (mark permanent) instead of just testing.
- Interleave other MCUmgr commands.

```js
import {
  WebHidTransport,
  McuMgrClient,
  requestSlxDevice,
} from './dist/mcumgr-web.js';

const device = await requestSlxDevice();
const transport = await WebHidTransport.fromDevice(device);
const client = new McuMgrClient(transport);

try {
  // --- 1. Inspect ---
  const before = await client.imageList();
  console.log(before.images);
  // [{ slot: 0, version, hash, active, confirmed, bootable, ... },
  //  { slot: 1, version, hash, ... }]

  // --- 2. (Optional) erase the inactive slot ---
  await client.imageErase();   // erases first non-active slot

  // --- 3. Upload ---
  const firmware = new Uint8Array(/* … */);
  await client.imageUpload(firmware, {
    onProgress: (sent, total) => updateBar(sent / total),
  });

  // --- 4. Find the just-uploaded image (the non-active one) and mark it ---
  const state = await client.imageList();
  const uploaded = state.images.find((img) => !img.active);
  await client.imageTest(uploaded.hash);
  // imageTest(hash, true) === confirm immediately (no revert on next boot)

  // --- 5. Reboot into MCUboot, which swaps slots and runs the new image ---
  await client.reset();
} finally {
  await transport.close();
}

// --- 6. After reboot, reopen and verify ---
//   Wait for device to reappear via navigator.hid.getDevices().
//   Then: imageList() → images[0] is now the new firmware.
//         If you used imageTest (not confirm), call imageConfirm to make it permanent
//         (imageTest with confirm=true on the new image's hash, while it's active).
```

### Test vs. confirm — the MCUboot dance

- `imageTest(hash)`: queues a one-shot test boot. MCUboot swaps slots, boots the new image. **If the new image doesn't call confirm before the next reboot, MCUboot reverts** (revert behavior depends on bootloader build — overwrite-only configs have no revert and effectively confirm on first boot).
- `imageTest(hash, true)`: marks `permanent=true`, equivalent to confirm — no revert.
- After a successful test boot, you can lock it in by calling `imageTest(activeHash, true)` against the now-active image.

For the SLX dongle build, MCUboot is configured such that a successful boot of the test image lands it as `active confirmed bootable` in slot 0 — observed behavior, no second confirm needed. Verify on your build by inspecting `imageList()` after reboot.

### Pass `image=N` for multi-image targets

`imageUpload(data, { image: 1 })` targets the second image (e.g. network core). Default is `image: 0`.

### Aborting an upload

```js
const ctrl = new AbortController();
abortBtn.onclick = () => ctrl.abort();
await client.imageUpload(firmware, { signal: ctrl.signal });
```

---

## Path C — MCUboot serial recovery (`WebSerialTransport`)

Use when the device is in MCUboot recovery mode (USB CDC-ACM, no application running).

**Key difference from HID/app flow:** there is **no test step**. Serial recovery `imageUpload` writes directly into the active slot — it overwrites the image in place. After `reset()`, the device boots straight into the new image. No `imageTest` / no swap / no revert.

```js
import {
  WebSerialTransport,
  McuMgrClient,
} from './dist/mcumgr-web.js';

// 1. User gesture → pick CDC-ACM port. Optionally filter by USB VID/PID.
const port = await navigator.serial.requestPort({
  filters: [{ usbVendorId: 0x361d /* , usbProductId: ... */ }],
});

// 2. Open the transport (defaults: 115200 baud, line length 128, MTU 256).
const transport = await WebSerialTransport.fromPort(port, {
  baudRate: 115200,
});
const client = new McuMgrClient(transport);

try {
  // 3. Upload — overwrites the current slot.
  const firmware = new Uint8Array(
    await (await fetch('zephyr.signed.bin')).arrayBuffer(),
  );
  await client.imageUpload(firmware, {
    onProgress: (sent, total) => updateBar(sent / total),
  });

  // 4. Reset — device boots the freshly written image.
  await client.reset();
} finally {
  await transport.close();
}
```

Notes:

- `imageList()` works in recovery and is useful for sanity checks (slot, version, hash). The bootloader's CBOR encoder may report a slightly truncated body; the transport tolerates this transparently.
- `echo` / `taskstat` / `osInfo` typically return `rc=8` (NOT_SUPPORTED) — MCUboot only implements a subset of OS+image commands.
- Serial recovery does **not** require `imageTest` or `imageConfirm`. Skip those calls; they don't apply.
- MCUboot's recovery upload is slower than HID (small line-length, base64 framing, single-line ack). Expect tens of seconds for a typical image.
- For Node, swap `WebSerialTransport` for `NodeSerialTransport` from the `mcumgr-web/node` entry point. Same `McuMgrClient` API.

```js
// Node equivalent
import { NodeSerialTransport } from 'mcumgr-web/node';

const transport = new NodeSerialTransport({ path: '/dev/ttyACM0' });
await transport.ready();
const client = new McuMgrClient(transport);
// … same imageUpload + reset sequence
```

---

## Other useful commands on `McuMgrClient`

```js
await client.echo('hi');                    // → 'hi'
await client.osInfo('s v b');               // OS info string
await client.bootloaderInfo();              // { bootloader, mode, noDowngrade }
await client.taskstat();                    // { tasks: { name: { prio, stkuse, ... } } }
await client.mcumgrParams();                // { bufSize, bufCount }
await client.imageErase(slotIndex);         // erase a specific slot
```

## Error handling

```js
import { McuMgrError } from './dist/mcumgr-web.js';

try {
  await client.imageTest(badHash);
} catch (e) {
  if (e instanceof McuMgrError) {
    console.error('mcumgr error', e.rc, e.message);
  } else {
    throw e;
  }
}
```

Common `rc` codes: `0` ok, `8` invalid arg / hash mismatch. Transient HID read timeouts can occur right after reset or during heavy traffic — retry once.

## Hash field gotcha

For builds using SHA-512 image hashes, `ImageStateEntry.hash` is 64 bytes (128 hex chars). Always pass the full `Uint8Array` from `imageList()` straight into `imageTest()`; don't truncate.

## IIFE bundle (no module loader)

```html
<script src="./dist/mcumgr-web.iife.js"></script>
<script>
  const { requestSlxDevice, SlxFirmwareUpdater } = window.McuMgrWeb;
  // … same code as ESM example
</script>
```

## End-to-end checklist

### App-mode update (HID)

1. Build firmware → `zephyr.signed.bin` (signed by `imgtool sign`).
2. Page served over `https://` or `localhost`.
3. User clicks button → call `requestSlxDevice()` (must be in user-gesture handler).
4. `new SlxFirmwareUpdater(device).updateFirmware(bytes, { onProgress, onPhaseChange })`.
5. On resolved promise, the device is rebooted, reconnected, and running the new image.

### Serial recovery (CDC-ACM)

1. Put device in MCUboot recovery mode (board-specific: button held at boot, or after a brick).
2. User clicks button → `navigator.serial.requestPort(...)` (user-gesture).
3. `WebSerialTransport.fromPort(port)` → `client.imageUpload(bytes)` → `client.reset()`.
4. Device boots into the freshly written image. No test/confirm step.
