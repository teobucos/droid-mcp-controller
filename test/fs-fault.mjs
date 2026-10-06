// Loaded only by the E2E child process: make directory fsync fail while a flag file exists.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  if (process.env.FSYNC_FAULT_FLAG && fs.existsSync(process.env.FSYNC_FAULT_FLAG) && fs.fstatSync(fd).isDirectory()) {
    throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
  }
  return original(fd);
};
syncBuiltinESMExports();
