// Discriminating probe: separates whole-process stalls (timer drift) from storage
// stalls (fsync latency on the tests' tmpdir). Logs every sample above 500 ms.
// Run beside `npm test` to tell host pauses from controller regressions:
//   node scripts/stall-probe.mjs /abs/probe.jsonl 250 & npm test
import { openSync, writeFileSync, fsyncSync, closeSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2];
const seconds = Number(process.argv[3] ?? 240);
const dir = mkdtempSync(join(tmpdir(), 'stall-probe-'));
const log = (data) => appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`);
let maxDrift = 0, maxFsync = 0, samples = 0;
let last = performance.now();
const drift = setInterval(() => {
  const now = performance.now();
  const late = now - last - 100;
  last = now;
  maxDrift = Math.max(maxDrift, late);
  if (late > 500) log({ kind: 'timer_drift_ms', value: Math.round(late) });
}, 100);
const fsyncLoop = setInterval(() => {
  const start = performance.now();
  const fd = openSync(join(dir, 'f'), 'w');
  writeFileSync(fd, String(start)); fsyncSync(fd); closeSync(fd);
  const d = openSync(dir, 'r'); fsyncSync(d); closeSync(d);
  const took = performance.now() - start;
  samples++;
  maxFsync = Math.max(maxFsync, took);
  if (took > 500) log({ kind: 'fsync_ms', value: Math.round(took) });
}, 250);
setTimeout(() => {
  clearInterval(drift); clearInterval(fsyncLoop); rmSync(dir, { recursive: true, force: true });
  log({ kind: 'summary', seconds, fsyncSamples: samples, maxDriftMs: Math.round(maxDrift), maxFsyncMs: Math.round(maxFsync) });
}, seconds * 1000);
