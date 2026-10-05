import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, rmSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { approvedWorkspace, pathsOverlap } from './config.mjs';

const activeStates = new Set(['starting', 'running', 'cancelling']);
const levels = ['off', 'low', 'medium', 'high'];
const now = () => new Date().toISOString();
const resultState = (result, reason) => reason === 'timeout' ? 'timed_out' : result.subtype === 'success' ? 'succeeded' : result.subtype === 'interrupted' ? 'interrupted' : 'failed';
const persistedRun = z.object({
  runId: z.string().uuid(), requestKey: z.string(), fingerprint: z.string(),
  workspace: z.string(), autonomy: z.enum(levels), createdAt: z.string().datetime({ offset: true }),
  droidSessionId: z.string().uuid().nullable(),
  state: z.enum(['starting', 'running', 'cancelling', 'unknown', 'succeeded', 'failed', 'interrupted', 'cancelled', 'timed_out']),
  events: z.array(z.object({ type: z.string() }).passthrough()), textTail: z.string(), stderrTail: z.string(),
}).passthrough();
const stateIdentity = { host: z.string(), home: z.string(), factoryHomeOverride: z.string().nullable() };
const persistedState = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...stateIdentity, runs: z.record(persistedRun.extend({ prompt: z.string() })) }),
  z.object({ version: z.literal(2), ...stateIdentity, runs: z.record(persistedRun.extend({ prompt: z.never().optional() })), sessionHeads: z.record(z.string().uuid(), z.string().uuid()) }),
]);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

// Write, sync, then replace: readers see an entire old or entire new record.
function atomicJson(path, data) {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(join(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class Controller {
  constructor(config) {
    this.config = config;
    this.workers = new Map();
    this.stopping = false;
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
    this.dir = realpathSync(config.stateDirectory);
    if ((statSync(this.dir).mode & 0o077) !== 0) throw new Error('State directory must be private (chmod 700)');
    this.lockPath = join(this.dir, 'owner.json');
    this.statePath = join(this.dir, 'state.json');
    const startup = join(this.dir, '.startup-lock');
    // Serialize stale-owner recovery. A crash here fails closed; manual cleanup
    // is preferable to racing two controller owners.
    try { mkdirSync(startup, { mode: 0o700 }); } catch { throw new Error('State startup locked; inspect owner before removing .startup-lock'); }
    let ownLock = false;
    try {
      if (existsSync(this.lockPath)) {
        const owner = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(JSON.parse(readFileSync(this.lockPath, 'utf8')));
        if (owner.host !== hostname() || alive(owner.pid)) throw new Error('Controller already running or state locked on another host');
        unlinkSync(this.lockPath);
      }
      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 });
      ownLock = true;
      const factoryHomeOverride = process.env.FACTORY_HOME_OVERRIDE ?? null;
      this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : { version: 2, host: hostname(), home: homedir(), factoryHomeOverride, runs: {}, sessionHeads: {} };
      persistedState.parse(this.state);
      if (this.state.host !== hostname() || this.state.home !== homedir() || this.state.factoryHomeOverride !== factoryHomeOverride) {
        throw new Error('Invalid state or state belongs to another host/HOME; do not reset it');
      }
      if (this.state.version === 1) {
        this.state.sessionHeads = {};
        // Stable sort: equal timestamps retain durable insertion/acceptance order.
        for (const run of Object.values(this.state.runs).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
          if (run.droidSessionId) this.state.sessionHeads[run.droidSessionId] = run.runId;
          delete run.prompt;
        }
        this.state.version = 2;
      }
      for (const [sessionId, headId] of Object.entries(this.state.sessionHeads)) {
        if (this.state.runs[headId]?.droidSessionId !== sessionId) throw new Error('Corrupt state: session head missing or belongs to another session');
      }
      for (const [id, run] of Object.entries(this.state.runs)) {
        if (id !== run.runId) throw new Error('Corrupt state: runId differs from record key');
        if (run.droidSessionId && !this.state.sessionHeads[run.droidSessionId]) throw new Error('Corrupt state: missing session head');
        if (activeStates.has(run.state)) {
          run.finishedAt = now();
          if (run.result) {
            const result = JSON.parse(readFileSync(join(this.dir, `${id}.result.json`), 'utf8'));
            if (result.sessionId !== run.droidSessionId) throw new Error('Corrupt state: terminal session UUID mismatch');
            run.state = resultState(result, run.stopReason);
          } else {
            run.state = 'unknown';
            run.error = 'Controller stopped before a durable terminal outcome. Reconcile Droid history and workspace locally; work was not replayed.';
          }
        }
      }
      this.save();
    } catch (error) {
      if (ownLock) unlinkSync(this.lockPath);
      throw error;
    } finally { rmSync(startup, { recursive: true }); }
  }

  save() { atomicJson(this.statePath, this.state); }
  get(runId) {
    const run = Object.hasOwn(this.state.runs, runId) && this.state.runs[runId];
    if (!run) throw new Error('Unknown controller runId (not a Droid session UUID)');
    return run;
  }
  status(runId) {
    const { fingerprint, result, ...status } = this.get(runId);
    return { ...status, terminal: !activeStates.has(status.state) };
  }
  list({ offset = 0, limit = 25 } = {}) {
    const runs = Object.values(this.state.runs).reverse();
    return { runs: runs.slice(offset, offset + limit).map((r) => this.status(r.runId)), total: runs.length, nextOffset: offset + limit < runs.length ? offset + limit : null };
  }
  result({ runId, offset = 0, limit = 12000 }) {
    const run = this.get(runId);
    const result = run.result ? JSON.parse(readFileSync(join(this.dir, `${runId}.result.json`), 'utf8')) : null;
    const text = result?.text ?? run.textTail;
    return {
      ...this.status(runId), resultAvailable: Boolean(result), partial: !result,
      text: text.slice(offset, offset + limit), totalCharacters: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      outcome: result ? { subtype: result.subtype, success: result.success, durationMs: result.durationMs, tokenUsage: result.tokenUsage, error: result.error, structuredOutputError: result.structuredOutputError } : null,
    };
  }
  start(args) { return this.accept(args); }
  continue(args) {
    const source = this.get(args.runId);
    if (!source.droidSessionId) throw new Error('No durable Droid session UUID to continue');
    return this.accept({ ...args, workspace: source.workspace }, source);
  }
  accept(args, source) {
    const workspace = approvedWorkspace(this.config, args.workspace);
    const duplicate = Object.values(this.state.runs).find((run) => run.requestKey === args.requestKey);
    // Replays retain their accepted defaults, including records predating per-turn reasoning.
    const autonomy = args.autonomy ?? (duplicate ? duplicate.autonomy : this.config.defaultAutonomy);
    const reasoningEffort = args.reasoningEffort ?? (duplicate ? duplicate.reasoningEffort : this.config.reasoningEffort);
    const puckConversationId = args.puckConversationId ?? (duplicate ? duplicate.puckConversationId : source?.puckConversationId ?? this.config.puck?.conversationId);
    if (puckConversationId && !this.config.puck) throw new Error('Puck MCP is not configured on this host');
    const intent = { workspace, prompt: args.prompt, autonomy, model: args.model ?? null, parentRunId: source?.runId ?? null, ...(reasoningEffort ? { reasoningEffort } : {}), ...(puckConversationId ? { puckConversationId } : {}) };
    const fingerprint = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new Error('requestKey was already used with different arguments');
      return this.status(duplicate.runId);
    }
    if (levels.indexOf(autonomy) > levels.indexOf(this.config.maxAutonomy)) throw new Error('Requested autonomy exceeds configured maxAutonomy');
    if (this.stopping) throw new Error('Controller is shutting down');
    if (source) {
      const family = Object.values(this.state.runs).filter((r) => r.droidSessionId === source.droidSessionId);
      if (family.some((r) => r.state === 'unknown')) throw new Error('Session has an unknown outcome; reconcile it locally before further work');
      if (family.some((r) => activeStates.has(r.state))) throw new Error('Session has an active turn; cancel/wait before continuing');
      const headRunId = this.state.sessionHeads[source.droidSessionId];
      if (headRunId !== source.runId) throw Object.assign(new Error('Run is not the current head of this Droid session'), { code: 'not_session_head', headRunId });
    }
    for (const id of this.workers.keys()) {
      const active = this.get(id);
      if ((autonomy !== 'off' || active.autonomy !== 'off') && pathsOverlap(workspace, active.workspace)) {
        throw Object.assign(new Error('Workspace is busy with another active run'), { code: 'workspace_busy', conflictingRunId: id, workspace: active.workspace });
      }
    }
    if (this.workers.size >= this.config.maxConcurrentRuns) throw new Error('Controller busy: maxConcurrentRuns reached');
    const { prompt, ...metadata } = intent;
    const run = {
      ...metadata, runId: randomUUID(), requestKey: args.requestKey, fingerprint,
      droidSessionId: source?.droidSessionId ?? null, state: 'starting', createdAt: now(),
      updatedAt: now(), events: [], textTail: '', stderrTail: '', cancelRequested: false,
    };
    this.state.runs[run.runId] = run;
    if (run.droidSessionId) this.state.sessionHeads[run.droidSessionId] = run.runId;
    this.save(); // Idempotency and intent are durable BEFORE any subprocess starts.
    this.launch(run, prompt);
    return this.status(run.runId);
  }
  launch(run, prompt) {
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      cwd: run.workspace, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    });
    const entry = { child, result: null, error: null, reason: null };
    this.workers.set(run.runId, entry);
    entry.timer = setTimeout(() => this.stopWorker(run, 'timeout'), this.config.runTimeoutMs);
    child.stderr.on('data', (data) => this.message(run, { kind: 'stderr', text: data.toString() }));
    child.on('message', (msg) => {
      if (msg.kind === 'result') {
        if (msg.result.sessionId !== run.droidSessionId) { entry.error = 'Terminal result sessionId mismatch'; return; }
        // SDK results also contain user-message copies of submitted prompts.
        // Preserve assistant/tool output and outcome, not original input copies.
        entry.result = { ...msg.result, messages: msg.result.messages.filter((message) => message.type !== 'user') };
        atomicJson(join(this.dir, `${run.runId}.result.json`), entry.result);
        run.result = true;
        this.save(); // Keep the result durable even if controller dies during cleanup.
        clearTimeout(entry.timer);
        entry.killTimer ??= setTimeout(() => this.killGroup(child.pid), this.config.cancelGraceMs);
      } else if (msg.kind === 'error') entry.error = msg.error;
      else this.message(run, msg);
    });
    child.on('error', (error) => { entry.error = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      // A worker's process group contains only that worker and its Droid child.
      // Kill any descendants before releasing the serial-session slot.
      this.killGroup(child.pid);
      this.workers.delete(run.runId);
      const result = entry.result;
      if (result) {
        if (result.sessionId !== run.droidSessionId) {
          run.state = 'failed'; run.error = 'Terminal result sessionId mismatch';
        } else {
          run.state = resultState(result, entry.reason);
          run.error = result.error?.message ?? result.structuredOutputError?.message ?? null;
        }
      } else {
        run.state = entry.reason === 'timeout' ? 'timed_out' : entry.reason === 'cancel' ? 'cancelled' : 'failed';
        run.error = entry.error ?? `No terminal Droid result; worker exited (${signal ?? code})`;
      }
      run.finishedAt = now(); run.updatedAt = now();
      this.save();
    });
    child.send({ run, prompt, config: { droidPath: this.config.droidPath, approvedDirectories: this.config.approvedDirectories, reasoningEffort: this.config.reasoningEffort, puck: this.config.puck } });
  }
  message(run, msg) {
    run.updatedAt = now();
    if (msg.kind === 'session') {
      run.droidSessionId = msg.sessionId;
      this.state.sessionHeads[msg.sessionId] = run.runId;
      if (run.state !== 'cancelling') run.state = 'running';
    } else if (msg.kind === 'stderr') run.stderrTail = (run.stderrTail + msg.text).slice(-16000);
    else if (msg.kind === 'event') {
      run.events.push({ at: now(), ...msg.event });
      run.events = run.events.slice(-20);
      if (msg.event.type === 'assistant' && typeof msg.event.text === 'string') run.textTail = (run.textTail + msg.event.text + '\n').slice(-16000);
    }
    this.save();
  }
  killGroup(pid) {
    if (!pid) return;
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  stopWorker(run, reason) {
    const entry = this.workers.get(run.runId);
    if (!entry || entry.reason) return;
    entry.reason = reason;
    run.state = 'cancelling'; run.cancelRequested = true; run.stopReason = reason;
    this.save();
    if (entry.child.connected) entry.child.send({ cancel: true }, () => {});
    entry.killTimer ??= setTimeout(() => this.killGroup(entry.child.pid), this.config.cancelGraceMs);
  }
  cancel(runId) {
    const run = this.get(runId);
    if (activeStates.has(run.state)) this.stopWorker(run, 'cancel');
    return this.status(runId);
  }
  async close() {
    this.stopping = true;
    for (const id of this.workers.keys()) this.cancel(id);
    while (this.workers.size) await new Promise((r) => setTimeout(r, 20));
    unlinkSync(this.lockPath);
  }
}
