// Durable controller state: single-owner lock, atomic writes, versioned
// migration with a retained byte-identical backup, and fail-closed recovery.
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, rmSync, realpathSync, existsSync, statSync, copyFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const levels = ['off', 'low', 'medium', 'high'];
export const RUN_STATES = ['queued', 'starting', 'running', 'cancelling', 'unknown', 'succeeded', 'failed', 'interrupted', 'cancelled', 'timed_out'];
export const LIVE = new Set(['starting', 'running', 'cancelling']);
export const WORKING = new Set(['queued', ...LIVE]);
export const resultState = (result, reason) => reason === 'timeout' ? 'timed_out' : result.subtype === 'success' ? 'succeeded' : result.subtype === 'interrupted' ? 'interrupted' : 'failed';
const now = () => new Date().toISOString();
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

const baseRun = z.object({
  runId: z.string().uuid(), requestKey: z.string(), fingerprint: z.string(),
  workspace: z.string(), autonomy: z.enum(levels), createdAt: z.string().datetime({ offset: true }),
  droidSessionId: z.string().uuid().nullable(),
  state: z.enum(RUN_STATES),
  events: z.array(z.object({ type: z.string() }).passthrough()), textTail: z.string(), stderrTail: z.string(),
}).passthrough();
const identity = { host: z.string(), home: z.string(), factoryHomeOverride: z.string().nullable() };
const sessionRecord = z.object({
  sessionId: z.string().uuid(), seq: z.number().int().min(1), title: z.string(), labels: z.array(z.string()), archived: z.boolean(),
  workspace: z.string(), replyTo: z.string().nullable(), droidSessionId: z.string().uuid().nullable(), headRunId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
const persisted = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...identity, runs: z.record(baseRun.extend({ prompt: z.string() })) }),
  z.object({ version: z.literal(2), ...identity, runs: z.record(baseRun.extend({ prompt: z.never().optional() })), sessionHeads: z.record(z.string().uuid(), z.string().uuid()) }),
  z.object({ version: z.literal(3), ...identity, nextSeq: z.number().int().min(1), runs: z.record(baseRun.extend({ sessionId: z.string().uuid(), prompt: z.never().optional() })), sessions: z.record(sessionRecord) }),
]);

// Write, sync, then replace: readers see an entire old or entire new record.
export function atomicJson(path, data) {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(join(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export const defaultTitle = (sessionId) => `Droid session ${sessionId.slice(0, 8)}`;

// v1 -> v2: prompts are never retained; heads follow acceptance time.
function toV2(state) {
  state.sessionHeads = {};
  // Stable sort: equal timestamps retain durable insertion/acceptance order.
  for (const run of Object.values(state.runs).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (run.droidSessionId) state.sessionHeads[run.droidSessionId] = run.runId;
    delete run.prompt;
  }
  state.version = 2;
}

// v2 -> v3: group runs by Droid session into controller sessions. A run that
// never obtained a Droid session UUID is its own session. Recorded routing is
// preserved as that session's replyTo; nothing is retargeted.
function toV3(state) {
  for (const run of Object.values(state.runs)) {
    for (const key of ['updatedAt', 'finishedAt']) if (run[key] !== undefined && !Number.isFinite(Date.parse(run[key]))) throw new Error(`Corrupt state: invalid ${key} on a run`);
  }
  const sessions = {};
  const byDroid = new Map();
  let seq = 1;
  for (const run of Object.values(state.runs).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    let session = run.droidSessionId ? byDroid.get(run.droidSessionId) : undefined;
    if (!session) {
      const sessionId = randomUUID();
      session = { sessionId, seq: seq++, title: defaultTitle(sessionId), labels: [], archived: false, workspace: run.workspace, replyTo: null, droidSessionId: run.droidSessionId, headRunId: run.runId, createdAt: run.createdAt, updatedAt: run.createdAt };
      sessions[sessionId] = session;
      if (run.droidSessionId) byDroid.set(run.droidSessionId, session);
    }
    run.sessionId = session.sessionId;
    run.replyTo = run.puckConversationId ?? null;
    delete run.puckConversationId;
    run.preview = run.textTail.slice(-4000);
    if (run.droidSessionId || run.result) run.submittedAt = run.createdAt; // legacy: the prompt reached Droid once a session existed
    session.headRunId = state.sessionHeads[run.droidSessionId] ?? run.runId;
    session.updatedAt = run.updatedAt ?? run.createdAt;
  }
  // The head (validated before migration) decides the session's recorded routing.
  for (const session of Object.values(sessions)) session.replyTo = state.runs[session.headRunId].replyTo;
  state.sessions = sessions;
  state.nextSeq = seq;
  delete state.sessionHeads;
  state.version = 3;
}

export function openStore(config) {
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const dir = realpathSync(config.stateDirectory);
  if ((statSync(dir).mode & 0o077) !== 0) throw new Error('State directory must be private (chmod 700)');
  const lockPath = join(dir, 'owner.json');
  const statePath = join(dir, 'state.json');
  const startup = join(dir, '.startup-lock');
  // Serialize stale-owner recovery. A crash here fails closed; manual cleanup
  // is preferable to racing two controller owners.
  try { mkdirSync(startup, { mode: 0o700 }); } catch { throw new Error('State startup locked; inspect owner before removing .startup-lock'); }
  let ownLock = false;
  let state;
  try {
    if (existsSync(lockPath)) {
      const owner = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(JSON.parse(readFileSync(lockPath, 'utf8')));
      if (owner.host !== hostname() || alive(owner.pid)) throw new Error('Controller already running or state locked on another host');
      unlinkSync(lockPath);
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 });
    ownLock = true;
    const factoryHomeOverride = process.env.FACTORY_HOME_OVERRIDE ?? null;
    const raw = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 3, host: hostname(), home: homedir(), factoryHomeOverride, nextSeq: 1, runs: {}, sessions: {} };
    persisted.parse(raw);
    state = raw;
    if (state.host !== hostname() || state.home !== homedir() || state.factoryHomeOverride !== factoryHomeOverride) {
      throw new Error('Invalid state or state belongs to another host/HOME; do not reset it');
    }
    const loadedVersion = state.version;
    const keys = new Set();
    for (const run of Object.values(state.runs)) {
      if (!Number.isFinite(Date.parse(run.createdAt))) throw new Error('Corrupt state: invalid createdAt on a run');
      if (keys.has(run.requestKey)) throw new Error('Corrupt state: duplicate requestKey');
      keys.add(run.requestKey);
    }
    if (state.version === 1) toV2(state);
    if (state.version === 2) {
      for (const [sessionId, headId] of Object.entries(state.sessionHeads)) {
        if (state.runs[headId]?.droidSessionId !== sessionId) throw new Error('Corrupt state: session head missing or belongs to another session');
      }
      for (const run of Object.values(state.runs)) {
        if (run.droidSessionId && !state.sessionHeads[run.droidSessionId]) throw new Error('Corrupt state: missing session head');
      }
      toV3(state);
      persisted.parse(state); // The candidate must itself be valid before anything is written.
      // Validated: keep the pre-migration bytes next to the new state, never overwriting a backup.
      let backup = `${statePath}.v${loadedVersion}.bak`;
      if (existsSync(backup)) backup = `${backup}.${Date.now()}`; // never overwrite, never skip: this file is THIS migration's preimage
      { copyFileSync(statePath, backup, constants.COPYFILE_EXCL); const fd = openSync(backup, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    }
    const seqs = new Set();
    for (const session of Object.values(state.sessions)) {
      if (seqs.has(session.seq)) throw new Error('Corrupt state: two sessions share a sequence number');
      seqs.add(session.seq);
    }
    if (seqs.size && state.nextSeq <= Math.max(...seqs)) throw new Error('Corrupt state: nextSeq is not above every session sequence');
    const sessionOf = new Set();
    for (const [id, session] of Object.entries(state.sessions)) {
      if (id !== session.sessionId) throw new Error('Corrupt state: sessionId differs from record key');
      if (state.runs[session.headRunId]?.sessionId !== id) throw new Error('Corrupt state: session head missing or belongs to another session');
      if (session.droidSessionId) {
        if (sessionOf.has(session.droidSessionId)) throw new Error('Corrupt state: Droid session shared by two controller sessions');
        sessionOf.add(session.droidSessionId);
      }
    }
    for (const [id, run] of Object.entries(state.runs)) {
      if (id !== run.runId) throw new Error('Corrupt state: runId differs from record key');
      if (!state.sessions[run.sessionId]) throw new Error('Corrupt state: run without session');
      if (run.droidSessionId && state.sessions[run.sessionId].droidSessionId && run.droidSessionId !== state.sessions[run.sessionId].droidSessionId) {
        throw new Error('Corrupt state: a run names a Droid session different from its controller session');
      }
      if (run.state === 'queued') {
        // Prompts are memory-only: a queued turn can never be resumed, and was never submitted.
        run.state = 'cancelled'; run.errorCode = 'queue_lost'; run.finishedAt = now();
        run.error = 'Controller restarted before this queued turn started; it was never submitted.';
      } else if (WORKING.has(run.state)) {
        run.finishedAt = now();
        if (run.result) {
          const result = JSON.parse(readFileSync(join(dir, `${id}.result.json`), 'utf8'));
          if (result.sessionId !== run.droidSessionId) throw new Error('Corrupt state: terminal session UUID mismatch');
          if (typeof result.subtype !== 'string' || !Array.isArray(result.messages) || typeof result.text !== 'string') {
            // An incomplete result must never be promoted to an outcome.
            run.state = 'unknown'; run.errorCode = 'unknown_outcome'; run.result = false;
            run.error = 'The stored terminal result is incomplete; reconcile Droid history and the workspace locally.';
          } else run.state = resultState(result, run.stopReason);
        } else {
          run.state = 'unknown'; run.errorCode = 'unknown_outcome';
          run.error = 'Controller stopped before a durable terminal outcome. Reconcile Droid history and workspace locally; work was not replayed.';
        }
      }
    }
  } catch (error) {
    if (ownLock) unlinkSync(lockPath);
    throw error;
  } finally { rmSync(startup, { recursive: true }); }

  let timer = null;
  const store = {
    dir, state,
    save() { clearTimeout(timer); timer = null; atomicJson(statePath, state); },
    // High-frequency progress (events, text) is coalesced; transitions use save().
    saveSoon() { timer ??= setTimeout(() => store.save(), 250); },
    resultPath: (runId) => join(dir, `${runId}.result.json`),
    release() { clearTimeout(timer); store.save(); unlinkSync(lockPath); },
  };
  store.save();
  return store;
}
