// Real worker + SDK + JSON-RPC peer. Parent IPC is deliberately controlled so
// a send callback cannot masquerade as durable application acknowledgment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { audit, sleep, root, processRunning } from './harness.mjs';

async function worker(t, ackTimeoutMs = 2000) {
  const dir = mkdtempSync(join(tmpdir(), 'droid-ack-'));
  mkdirSync(join(dir, 'mock')); mkdirSync(join(dir, 'workspace'));
  const messages = [];
  const child = fork(join(root, 'src/worker.mjs'), [], {
    detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, MOCK_DROID_HOME: join(dir, 'mock'), MOCK_AUDIT: join(dir, 'audit.jsonl') },
  });
  child.stderr.resume(); child.on('message', (msg) => messages.push(msg));
  // An explicitly disconnected IPC handle need not produce a final close event
  // on every Node version. Process exit is the lifecycle fact under test.
  const closed = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = { runId: randomUUID(), sessionId: randomUUID(), workspace: join(dir, 'workspace'), autonomy: 'off', model: 'mock-model', replyTo: null };
  child.send({ run, prompt: 'no-echo:ACK_MARKER', config: { droidPath: join(root, 'test/mock-droid.mjs'), approvedDirectories: [run.workspace], ackTimeoutMs } });
  const wait = async (predicate) => {
    for (let i = 0; i < 300; i++) { const value = predicate(); if (value) return value; await sleep(10); }
    throw new Error('Timed out waiting for worker');
  };
  const phase = (name) => wait(() => messages.find((m) => (m.kind === 'persist' && m.phase === name) || m.kind === name));
  const acknowledge = (msg, extra = {}) => child.send({ ...msg, kind: 'persisted', ...extra });
  return { dir, child, closed, messages, phase, acknowledge, wait, turns: () => audit({ dir }).filter((m) => m.method === 'droid.add_user_message') };
}

test('R2: no add_user_message until both correlated persistence acknowledgments, duplicates ignored', async (t) => {
  const h = await worker(t);
  const session = await h.phase('session');
  await sleep(150);
  assert.equal(h.turns().length, 0, 'IPC send callback is not persistence');
  for (const changed of [{ nonce: randomUUID() }, { runId: randomUUID() }, { sessionId: randomUUID() }, { droidSessionId: randomUUID() }, { phase: 'submission_intent' }]) h.acknowledge(session, changed);
  await sleep(100); assert.equal(h.turns().length, 0);
  h.acknowledge(session);
  const intent = await h.phase('submission_intent');
  h.acknowledge(session); // a duplicate old ACK cannot authorize a later phase
  await sleep(100); assert.equal(h.turns().length, 0);
  h.acknowledge(intent); h.acknowledge(intent);
  await h.closed;
  assert.equal(h.turns().length, 1);
  assert.ok(h.messages.some((m) => m.kind === 'result'));
});

for (const phase of ['session', 'submission_intent']) for (const mode of ['timeout', 'cancel', 'disconnect']) test(`R2: ${mode} while awaiting ${phase} persistence never submits`, async (t) => {
  const h = await worker(t, 250);
  const initial = await h.phase('session');
  if (phase === 'submission_intent') { h.acknowledge(initial); await h.phase(phase); }
  if (mode === 'cancel') h.child.send({ cancel: true });
  if (mode === 'disconnect') h.child.disconnect();
  await h.closed;
  assert.equal(h.turns().length, 0);
  for (const message of audit(h)) assert.equal(processRunning(message.mockPid), false);
});
