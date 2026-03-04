/** Error thrown for MCUmgr protocol errors and transport failures. */
export class McuMgrError extends Error {
  /** Device return code (from CBOR `rc` field), undefined for transport errors. */
  readonly rc?: number;

  constructor(message: string, rc?: number) {
    super(rc !== undefined ? `${message} (rc=${rc})` : message);
    this.name = 'McuMgrError';
    this.rc = rc;
  }
}
