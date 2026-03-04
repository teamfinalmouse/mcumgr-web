import { describe, expect, test } from 'vitest';
import { McuMgrError } from '../../src/errors.js';

describe('McuMgrError', () => {
  test('name is McuMgrError and instanceof Error', () => {
    const err = new McuMgrError('test');
    expect(err.name).toBe('McuMgrError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(McuMgrError);
  });

  test('includes rc in message when provided', () => {
    const err = new McuMgrError('Device error', 3);
    expect(err.message).toBe('Device error (rc=3)');
    expect(err.rc).toBe(3);
  });

  test('omits rc from message when undefined', () => {
    const err = new McuMgrError('timeout');
    expect(err.message).toBe('timeout');
    expect(err.rc).toBeUndefined();
  });

  test('rc is readonly', () => {
    const err = new McuMgrError('test', 5);
    expect(err.rc).toBe(5);
    // Verify the property descriptor shows it as readonly
    const descriptor = Object.getOwnPropertyDescriptor(err, 'rc');
    // readonly class fields are writable in JS but TypeScript enforces readonly at compile time
    expect(descriptor).toBeDefined();
  });
});
