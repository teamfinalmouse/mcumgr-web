#!/usr/bin/env node
// mcumgr-web CLI — MCUmgr operations over USB HID or MCUboot serial recovery.

import { program } from 'commander';
import { readFileSync } from 'fs';
import { McuMgrClient } from './client.js';
import { NodeHidTransport } from './node-hid.js';
import { NodeSerialTransport } from './node-serial.js';
import type { Transport } from './transport.js';

function hexToNumber(value: string): number {
  return parseInt(value, 16);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseHash(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    console.error(
      `Error: invalid hash — expected an even number of hex chars, got ${hex.length}`,
    );
    process.exit(1);
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

interface CliOpts {
  vid?: string;
  pid?: string;
  serial?: string;
  baud?: string;
  mtu?: string;
  lineLength?: string;
}

async function openTransport(raw: Record<string, unknown>): Promise<Transport> {
  const opts = raw as CliOpts;
  if (opts.serial) {
    const t = new NodeSerialTransport({
      path: opts.serial,
      baudRate: opts.baud ? parseInt(opts.baud, 10) : undefined,
      lineLength: opts.lineLength ? parseInt(opts.lineLength, 10) : undefined,
      mtu: opts.mtu ? parseInt(opts.mtu, 10) : undefined,
    });
    await t.ready();
    return t;
  }
  return new NodeHidTransport({
    vid: hexToNumber(opts.vid ?? '361d'),
    pid: hexToNumber(opts.pid ?? '0300'),
  });
}

program
  .name('mcumgr-web')
  .description('MCUmgr operations over USB HID or serial (MCUboot recovery)')
  .option('--vid <hex>', 'USB Vendor ID (HID)', '361d')
  .option('--pid <hex>', 'USB Product ID (HID)', '0300')
  .option('-s, --serial <path>', 'Serial device path (CDC-ACM)')
  .option('-b, --baud <n>', 'Serial baud rate', '115200')
  .option('--line-length <n>', 'Serial line length', '128')
  .option('--mtu <n>', 'Serial MTU');

program
  .command('echo <message>')
  .description('Send an echo message')
  .action(async (message: string) => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const reply = await client.echo(message);
      console.log(reply);
    } finally {
      await transport.close();
    }
  });

program
  .command('info')
  .description('Show OS info')
  .option('-f, --format <format>', 'info format string')
  .action(async (cmdOpts: { format?: string }) => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const output = await client.osInfo(cmdOpts.format);
      console.log(output);
    } finally {
      await transport.close();
    }
  });

program
  .command('bootloader')
  .description('Show bootloader info')
  .action(async () => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const info = await client.bootloaderInfo();
      console.log(`bootloader: ${info.bootloader}`);
      if (info.mode !== undefined) console.log(`mode: ${info.mode}`);
      if (info.noDowngrade !== undefined)
        console.log(`no-downgrade: ${info.noDowngrade}`);
    } finally {
      await transport.close();
    }
  });

program
  .command('taskstat')
  .description('Show OS task statistics')
  .action(async () => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const resp = await client.taskstat();
      for (const [name, task] of Object.entries(resp.tasks)) {
        console.log(
          ` ${name}: prio=${task.prio} state=${task.state} stkuse=${task.stkuse}/${task.stksiz} cswcnt=${task.cswcnt}`,
        );
      }
    } finally {
      await transport.close();
    }
  });

program
  .command('params')
  .description('Show MCUmgr buffer parameters')
  .action(async () => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const params = await client.mcumgrParams();
      console.log(`buf_size: ${params.bufSize}`);
      console.log(`buf_count: ${params.bufCount}`);
    } finally {
      await transport.close();
    }
  });

program
  .command('list')
  .description('List image slots')
  .action(async () => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      const state = await client.imageList();
      for (const img of state.images) {
        const flags = [
          img.active ? 'active' : '',
          img.confirmed ? 'confirmed' : '',
          img.pending ? 'pending' : '',
          img.bootable ? 'bootable' : '',
          img.permanent ? 'permanent' : '',
        ]
          .filter(Boolean)
          .join(' ');
        console.log(
          ` image=${img.image} slot=${img.slot} ver=${img.version} hash=${toHex(img.hash)} ${flags}`,
        );
      }
    } finally {
      await transport.close();
    }
  });

program
  .command('upload <file>')
  .description('Upload firmware image')
  .action(async (file: string) => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const data = new Uint8Array(readFileSync(file));
      console.log(`Uploading ${file} (${data.length} bytes)`);
      const client = new McuMgrClient(transport);
      let lastPct = -1;
      await client.imageUpload(data, {
        onProgress: (sent, total) => {
          const pct = Math.floor((sent / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\rUploading... ${pct}%`);
          }
        },
      });
      process.stdout.write('\n');
      console.log('Upload complete');
    } finally {
      await transport.close();
    }
  });

program
  .command('test <hash>')
  .description('Mark image for test boot (hash as hex string)')
  .action(async (hashHex: string) => {
    const hash = parseHash(hashHex);
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      await client.imageTest(hash);
      console.log('Image marked for test boot');
    } finally {
      await transport.close();
    }
  });

program
  .command('erase [slot]')
  .description('Erase image slot')
  .action(async (slot?: string) => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      await client.imageErase(slot !== undefined ? parseInt(slot, 10) : undefined);
      console.log('Erase complete');
    } finally {
      await transport.close();
    }
  });

program
  .command('reset')
  .description('Reset device')
  .action(async () => {
    const opts = program.opts();
    const transport = await openTransport(opts);
    try {
      const client = new McuMgrClient(transport);
      await client.reset();
      console.log('Reset sent');
    } finally {
      await transport.close();
    }
  });

program.parseAsync().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
