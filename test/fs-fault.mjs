// Loaded only by the E2E child process: make directory fsync fail while a flag file exists.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.fsyncSync;
const write = fs.writeFileSync;
let targeted = false, fired = false;
fs.writeFileSync = (fd, data, ...args) => {
  if (process.env.PERSIST_FAULT_PHASE && typeof fd === 'number' && typeof data === 'string') {
    const state = JSON.parse(data);
    targeted = Object.values(state.runs ?? {}).some((run) => process.env.PERSIST_FAULT_PHASE === 'supersede'
      ? run.errorCode === 'superseded'
      : process.env.PERSIST_FAULT_PHASE === 'session' ? run.state === 'running' && run.droidSessionId
        : run.submissionIntentAt || run.submittedAt);
  }
  return write(fd, data, ...args);
};
fs.fsyncSync = (fd) => {
  if (targeted && !fired && fs.fstatSync(fd).isDirectory()) {
    fired = true;
    write(process.env.PERSIST_FAULT_MARKER, 'reached');
    if (process.env.PERSIST_FAULT_MODE === 'fail') throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(process.env.PERSIST_FAULT_RELEASE)) {
      if (Date.now() > deadline) throw new Error('persistence test gate timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (process.env.FSYNC_FAULT_FLAG && fs.existsSync(process.env.FSYNC_FAULT_FLAG) && fs.fstatSync(fd).isDirectory()) {
    throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
  }
  return original(fd);
};
syncBuiltinESMExports();
