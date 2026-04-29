import * as McuMgrWeb from './index.js';

(globalThis as unknown as { McuMgrWeb: typeof McuMgrWeb }).McuMgrWeb = McuMgrWeb;
