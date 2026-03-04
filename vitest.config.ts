import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 10_000,
    // Device tests share a single physical HID device — must run sequentially.
    fileParallelism: false,
  },
});
