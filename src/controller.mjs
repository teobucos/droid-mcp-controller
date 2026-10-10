// Session core. A controller session owns one linear chain of turns ("runs") over
// one Droid session. create()/send() accept turns; the scheduler admits them
// FIFO under three rules:
//   1. global capacity (maxConcurrentRuns),
//   2. one live turn per session,
//   3. canonical workspace reader/writer locks (off = reader, anything else = writer).
// Admission is the only place that decides when a turn starts; prompts live in
// memory only and are never persisted.
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { approvedWorkspace, pathsOverlap, contains, looksFast } from './config.mjs';
import { ToolError } from './errors.mjs';
import { openStore, atomicJson, defaultTitle, resultState, LIVE, WORKING } from './store.mjs';
import { sessionStatus, isWorking, resultMessages, noticeMessage, turnNotices, scrub } from './views.mjs';
import { isReplyHandle } from './puck.mjs';

const levels = ['off', 'low', 'medium', 'high'];
const MAX_QUEUED = 64;
const MAX_PENDING_PER_SESSION = 8;
const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
// Potentially submitted, not proof of Factory acceptance. submittedAt is the
// older v3 intent marker (and an approximation on migrated v1/v2 records).
const submitted = (run) => Boolean(run.submissionIntentAt || run.submittedAt || run.result || run.state === 'unknown');
const conflicts = (a, b) => (a.autonomy !== 'off' || b.autonomy !== 'off') && pathsOverlap(a.workspace, b.workspace);

function cursorOf(cursor) {
  if (cursor === undefined) return null;
  if (!/^\d{1,9}$/.test(cursor)) throw new ToolError('invalid_cursor', 'Invalid cursor');
  return Number(cursor);
}

export class Controller {
  constructor(config, models) {
    this.config = config;
    this.models = models;
    this.store = openStore(config);
    this.state = this.store.state;
    this.dir = this.store.dir;
    this.workers = new Map();
    this.queue = [];
    this.stopping = false;
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(0);
    this.keys = new Map();
    this.bySession = new Map();
    for (const run of Object.values(this.state.runs).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) this.index(run);
  }

  index(run) {
    this.keys.set(run.requestKey, run.runId);
    if (!this.bySession.has(run.sessionId)) this.bySession.set(run.sessionId, []);
    this.bySession.get(run.sessionId).push(run.runId);
  }
  runsOf(sessionId) { return this.bySession.get(sessionId).map((id) => this.state.runs[id]); }
  replyHandlesFor(run) {
    const handles = new Set();
    // Accepted detaches/retargets invalidate the earlier route, even if those
    // turns were cancelled or routing later returns to the original recipient.
    // Stop at this run: queued future routing cannot alter its authorization.
    for (const prior of this.runsOf(run.sessionId)) {
      if (prior.runId === run.runId) break;
      if (prior.replyTo === run.replyTo && prior.replyRouteId === run.replyRouteId) {
        for (const handle of prior.replyHandles) if (isReplyHandle(handle, run.replyTo)) handles.add(handle);
      }
    }
    return [...handles];
  }
  session(id) {
    if (!Object.hasOwn(this.state.sessions, id)) throw new ToolError('unknown_session', 'Unknown session handle');
    return this.state.sessions[id];
  }
  // Persist a change and wake waiters. Progress-only changes are coalesced.
  changed(run, { soon = false } = {}) {
    run.updatedAt = now();
    this.state.sessions[run.sessionId].updatedAt = run.updatedAt;
    if (soon) this.store.saveSoon(); else this.store.save();
    this.changes.emit('change');
  }

  // ---- session surface -----------------------------------------------------
  status(sessionId) {
    const session = this.session(sessionId);
    return sessionStatus(session, this.runsOf(sessionId));
  }

  // Accepted keys replay without the catalog, so later catalog changes cannot break them.
  async create(args) {
    const catalog = this.keys.has(args.requestKey) ? null : await this.models.get();
    return this.status(this.accept({ kind: 'create', ...args }, catalog).sessionId);
  }

  async send(args) {
    const catalog = this.keys.has(args.requestKey) ? null : await this.models.get();
    const run = this.accept({ kind: 'send', ...args }, catalog);
    return { runId: run.runId, disposition: run.disposition, status: this.status(run.sessionId) };
  }

  // Effective settings for a NEW turn, validated against the live catalog (never a
  // list we keep). Explicit values win and are strict. A follow-up inherits the last
  // accepted turn of its session (including queued work), so host defaults never
  // silently change a session; a create falls back to the host defaults.
  resolveSettings(intent, head, catalog) {
    const { config } = this;
    const model = intent.model ?? head?.model ?? config.defaultModel;
    const source = intent.model ? 'requested' : head?.model ? 'session' : 'host';
    if (!model) throw new ToolError('model_required', 'No model was given and the controller host has no defaultModel');
    const entry = catalog.models.find((item) => item.id === model);
    if (!entry) {
      const which = { requested: `Model "${model}"`, session: `The session's model "${model}"`, host: `The host defaultModel "${model}"` }[source];
      throw new ToolError('model_unavailable', `${which} is not in the current Factory catalog${source === 'requested' ? '' : '; pass model explicitly'}`);
    }
    if (source === 'host' && (looksFast(entry.id) || looksFast(entry.displayName))) {
      throw new ToolError('default_model_refused', `The host defaultModel "${model}" (${entry.displayName}) appears to be a Fast variant by name; Fast is never chosen automatically`);
    }

    let autonomy;
    if (intent.autonomy) {
      if (levels.indexOf(intent.autonomy) > levels.indexOf(config.maxAutonomy)) throw new ToolError('autonomy_exceeds_ceiling', `Requested autonomy exceeds configured maxAutonomy (${config.maxAutonomy})`);
      autonomy = intent.autonomy;
    } else if (head) autonomy = levels[Math.min(levels.indexOf(head.autonomy), levels.indexOf(config.maxAutonomy))];
    else autonomy = config.defaultAutonomy;

    const supported = entry.supportedReasoningEfforts;
    const fits = (effort) => Boolean(effort) && (!supported || supported.includes(effort));
    let reasoningEffort;
    if (intent.reasoningEffort) {
      if (!fits(intent.reasoningEffort)) throw new ToolError('reasoning_unsupported', `Model "${model}" supports reasoningEffort ${supported.join(', ')}; requested "${intent.reasoningEffort}"`);
      reasoningEffort = intent.reasoningEffort;
    } else if (head && head.model === model && fits(head.reasoningEffort)) reasoningEffort = head.reasoningEffort;
    else if (fits(config.reasoningEffort)) reasoningEffort = config.reasoningEffort;
    else if (fits(entry.defaultReasoningEffort)) reasoningEffort = entry.defaultReasoningEffort;
    else if (head && supported?.length) {
      // A resumed Droid session keeps its previous effort unless one is sent.
      throw new ToolError('reasoning_unsupported', `Model "${model}" supports reasoningEffort ${supported.join(', ')} and no supported default is known; pass reasoningEffort explicitly`);
    }
    return { model, autonomy, reasoningEffort };
  }

  // Synchronous and atomic: nothing awaits between the checks and the durable write.
  accept(intent, catalog) {
    const { kind, requestKey } = intent;
    const target = kind === 'send' ? this.session(intent.session) : null;
    // Resume re-authorizes the recorded workspace: roots can be revoked and symlinks can move.
    const workspace = approvedWorkspace(this.config, target ? target.workspace : intent.workspace);
    if (target && workspace !== target.workspace) throw new ToolError('workspace_not_approved', 'The session workspace no longer resolves to the directory it was created in');
    const dup = this.keys.has(requestKey) ? this.state.runs[this.keys.get(requestKey)] : null;
    // Replays compare against their ORIGINAL effective settings, never re-resolved
    // ones, so changed defaults, catalog or policy cannot alter an accepted key.
    let settings;
    if (dup) settings = { model: intent.model ?? dup.model, autonomy: intent.autonomy ?? dup.autonomy, reasoningEffort: intent.reasoningEffort ?? dup.reasoningEffort };
    else if (!catalog) throw new ToolError('internal_error', 'Request key state changed during validation; retry with the same arguments');
    else settings = this.resolveSettings(intent, target ? this.state.runs[target.headRunId] : null, catalog);
    const { autonomy, reasoningEffort } = settings;
    const replyTo = intent.replyTo !== undefined ? intent.replyTo : dup ? dup.replyTo : target.replyTo;
    const labels = intent.labels ? [...new Set(intent.labels)].sort() : [];
    const fingerprint = sha({
      kind, target: target?.sessionId ?? workspace, prompt: intent.prompt, autonomy, model: settings.model ?? null, reasoningEffort: reasoningEffort ?? null,
      // This fixed slot is part of the persisted session API hash format. Changing
      // it would invalidate current request keys; original prompts are not retained.
      replyTo, interrupt: Boolean(intent.interrupt), title: intent.title ?? null, labels, continuesRun: null,
    });
    if (dup) {
      if (dup.fingerprint !== fingerprint) throw new ToolError('request_key_conflict', 'requestKey was already used with different arguments');
      return dup;
    }
    if (this.stopping) throw new ToolError('shutting_down', 'Controller is shutting down');
    if (replyTo && !this.config.ampMcp) throw new ToolError('reply_back_unavailable', 'Amp MCP is not configured on this host; use replyTo:null or configure ampMcp');
    let runs = [];
    if (target) {
      runs = this.runsOf(target.sessionId);
      if (runs.some((run) => run.state === 'unknown')) throw new ToolError('session_unknown_outcome', 'Session has an unknown outcome; reconcile it locally before further work');
      if (!intent.interrupt && runs.filter((run) => WORKING.has(run.state)).length >= MAX_PENDING_PER_SESSION) throw new ToolError('queue_full', 'Too many turns are already pending on this session');
    }
    const superseded = intent.interrupt ? runs.filter((run) => run.state === 'queued') : [];
    if (this.queue.length - superseded.length >= MAX_QUEUED) throw new ToolError('queue_full', 'The controller admission queue is full');
    const stamp = now();
    const before = target ? { headRunId: target.headRunId, archived: target.archived, replyTo: target.replyTo, updatedAt: target.updatedAt } : null;
    const session = target ?? (() => {
      const sessionId = randomUUID();
      const created = { sessionId, seq: this.state.nextSeq++, title: intent.title ?? defaultTitle(sessionId), labels, archived: false, workspace, replyTo, droidSessionId: null, headRunId: null, createdAt: stamp, updatedAt: stamp };
      this.state.sessions[sessionId] = created;
      return created;
    })();
    const disposition = intent.interrupt && runs.some((run) => LIVE.has(run.state)) ? 'interrupting' : runs.some((run) => WORKING.has(run.state)) ? 'queued' : 'started';
    const runId = randomUUID();
    const run = {
      runId, sessionId: session.sessionId, requestKey, fingerprint, workspace, autonomy, model: settings.model,
      replyRouteId: target && target.replyTo === replyTo ? this.state.runs[target.headRunId].replyRouteId : runId,
      ...(reasoningEffort ? { reasoningEffort } : {}), replyTo, disposition, state: 'queued', createdAt: stamp, updatedAt: stamp,
      droidSessionId: null, replyHandles: [], events: [], textTail: '', stderrTail: '', preview: '', cancelRequested: false,
    };
    this.state.runs[run.runId] = run;
    this.index(run);
    session.headRunId = run.runId;
    if (target) { session.archived = false; session.replyTo = replyTo; }
    session.updatedAt = stamp;
    // Accept the steering turn and supersede old queued intent in ONE durable
    // write. Keep keys/history; no crash or replay may revive the stopped work.
    for (const old of superseded) this.state.runs[old.runId] = {
      ...old, state: 'cancelled', errorCode: 'superseded', supersededBy: run.runId,
      error: 'Superseded by an interrupting message before submission.', finishedAt: stamp, updatedAt: stamp,
    };
    try {
      this.store.save(); // Idempotency and intent are durable BEFORE any subprocess starts.
    } catch (error) {
      // Nothing durable was accepted, so nothing may stay accepted in memory either.
      for (const old of superseded) this.state.runs[old.runId] = old;
      delete this.state.runs[run.runId];
      this.keys.delete(requestKey);
      this.bySession.get(session.sessionId).pop();
      if (target) Object.assign(target, before);
      else { delete this.state.sessions[session.sessionId]; this.bySession.delete(session.sessionId); this.state.nextSeq--; }
      throw error;
    }
    if (superseded.length) this.queue = this.queue.filter((item) => item.run.sessionId !== session.sessionId);
    this.queue.push({ run, prompt: intent.prompt });
    if (disposition === 'interrupting') for (const live of runs.filter((item) => LIVE.has(item.state))) this.stopWorker(live, 'cancel');
    this.pump();
    // "started" means admitted; a turn still waiting for capacity or a lock is queued.
    if (run.disposition === 'started' && run.state === 'queued') { run.disposition = 'queued'; this.store.save(); }
    this.changes.emit('change');
    return run;
  }

  // FIFO admission. A queued turn is blocked by anything live or earlier in the
  // queue that conflicts, so a waiting writer is never starved by later readers.
  pump() {
    if (this.stopping) return;
    const blockers = [...this.workers.keys()].map((id) => this.state.runs[id]);
    const remaining = [];
    for (const item of this.queue) {
      const { run } = item;
      const blocked = this.workers.size >= this.config.maxConcurrentRuns
        || blockers.some((other) => other.sessionId === run.sessionId || conflicts(other, run));
      if (blocked) { remaining.push(item); blockers.push(run); }
      else if (!this.stillAuthorized(run)) this.reject(run, 'workspace_not_approved', 'The workspace is no longer approved or no longer resolves to the same directory; nothing was submitted.');
      else { this.launch(run, item.prompt); blockers.push(run); }
    }
    this.queue = remaining;
  }

  stillAuthorized(run) {
    try { return approvedWorkspace(this.config, run.workspace) === run.workspace; } catch { return false; }
  }
  reject(run, code, message) {
    Object.assign(run, { state: 'failed', errorCode: code, error: message, finishedAt: now() });
    this.changed(run);
  }

  launch(run, prompt) {
    const session = this.state.sessions[run.sessionId];
    run.droidSessionId = session.droidSessionId;
    run.state = 'starting'; run.startedAt = now();
    this.changed(run);
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      cwd: run.workspace, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    });
    const entry = { child, result: null, error: null, errorCode: null, reason: null, persisted: new Map(), approvedReplySends: new Set() };
    this.workers.set(run.runId, entry);
    entry.timer = setTimeout(() => this.stopWorker(run, 'timeout'), this.config.runTimeoutMs);
    child.stderr.on('data', (data) => this.message(run, { kind: 'stderr', text: data.toString() }));
    child.on('message', (msg) => {
      if (msg.kind === 'persist') {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const valid = msg.runId === run.runId && msg.sessionId === run.sessionId
          && uuid.test(msg.nonce) && uuid.test(msg.droidSessionId)
          && (!run.droidSessionId || msg.droidSessionId === run.droidSessionId)
          && ['session', 'submission_intent'].includes(msg.phase)
          && (msg.phase === 'session' || entry.persisted.has('session'))
          && (!entry.persisted.has(msg.phase) || entry.persisted.get(msg.phase) === msg.nonce);
        if (!valid) { entry.error = 'Invalid worker persistence request'; this.killGroup(child.pid); return; }
        if (!entry.persisted.has(msg.phase)) {
          run.droidSessionId = msg.droidSessionId;
          session.droidSessionId = msg.droidSessionId;
          if (msg.phase === 'submission_intent') run.submissionIntentAt = now();
          if (run.state !== 'cancelling') run.state = 'running';
          this.changed(run); // atomicJson fsyncs the file AND directory before ACK.
          entry.persisted.set(msg.phase, msg.nonce);
        }
        if (!entry.reason && child.connected) child.send({ ...msg, kind: 'persisted' }, (error) => {
          if (error) { entry.error = 'Persistence acknowledgment delivery failed'; this.killGroup(child.pid); }
        });
      } else if (msg.kind === 'result') {
        if (msg.result.sessionId !== run.droidSessionId) { entry.error = 'Terminal result sessionId mismatch'; return; }
        // SDK results also contain user-message copies of submitted prompts.
        // Preserve assistant/tool output and outcome, not original input copies.
        entry.result = { ...msg.result, messages: msg.result.messages.filter((message) => message.type !== 'user') };
        atomicJson(this.store.resultPath(run.runId), entry.result);
        run.result = true;
        run.tokenUsage = msg.result.tokenUsage ?? null;
        if (msg.result.text) { run.preview = msg.result.text.slice(-4000); run.previewTruncated = msg.result.text.length > 4000; }
        this.changed(run); // Keep the result durable even if controller dies during cleanup.
        clearTimeout(entry.timer);
        entry.killTimer ??= setTimeout(() => this.killGroup(child.pid), this.config.cancelGraceMs);
      } else if (msg.kind === 'error') { entry.error = msg.error; entry.errorCode = msg.code ?? null; }
      else this.message(run, msg);
    });
    child.on('error', (error) => { entry.error = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      // A worker's process group contains only that worker and its Droid child.
      // Kill any descendants before releasing the slot and the workspace lock.
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
        if (entry.errorCode) run.errorCode = entry.errorCode;
        else if (run.state === 'cancelled') run.errorCode = 'cancelled';
      }
      run.finishedAt = now();
      this.changed(run);
      // A turn that ended with no terminal result leaves its session in doubt: queued follow-ups were
      // written for a different situation, so Puck decides instead of the queue resuming them.
      if (!result && (run.state === 'failed' || run.state === 'timed_out')) {
        for (const queued of this.runsOf(run.sessionId).filter((other) => other.state === 'queued')) {
          queued.predecessorRunId = run.runId;
          this.cancelRun(queued, 'predecessor_failed', 'The previous turn ended without a result, so this queued turn was dropped without being submitted.');
        }
      }
      this.pump();
    });
    child.send({
      run: { runId: run.runId, sessionId: run.sessionId, workspace: run.workspace, autonomy: run.autonomy, model: run.model, reasoningEffort: run.reasoningEffort, droidSessionId: run.droidSessionId, replyTo: run.replyTo },
      replyHandles: this.replyHandlesFor(run),
      factory: { title: this.pendingTitle(session), tags: session.droidSessionId ? [] : session.labels.map((name) => ({ name })) },
      prompt,
      config: { droidPath: this.config.droidPath, approvedDirectories: this.config.approvedDirectories, reasoningEffort: this.config.reasoningEffort, amp: this.config.ampMcp ?? null, ackTimeoutMs: Math.min(this.config.runTimeoutMs, 30000), titleTimeoutMs: Math.min(10000, Math.floor(this.config.runTimeoutMs / 4)) },
    });
  }

  // Title sync is recorded on runs (passthrough records) rather than the strict
  // session record, so state stays loadable by the previous release. Default
  // titles are never pushed: Factory's generated title is more useful than them.
  pendingTitle(session) {
    const applied = this.runsOf(session.sessionId).findLast((run) => run.titleSync?.state === 'applied')?.titleSync.title ?? null;
    if (session.title === applied) return null;
    return applied !== null || session.title !== defaultTitle(session.sessionId) ? session.title : null;
  }

  message(run, msg) {
    if (msg.kind === 'stderr') run.stderrTail = (run.stderrTail + msg.text).slice(-16000);
    else if (msg.kind === 'title') {
      if (typeof msg.title !== 'string' || !['applied', 'failed'].includes(msg.state)) return;
      run.titleSync = { state: msg.state, title: msg.title, ...(msg.state === 'failed' ? { error: scrub(String(msg.error ?? 'rename failed')).slice(0, 500) } : {}) };
      run.events.push({ at: now(), type: msg.state === 'applied' ? 'title_synced' : 'title_sync_failed', ...(run.titleSync.error ? { message: run.titleSync.error } : {}) });
      run.events = run.events.slice(-20);
      if (msg.state === 'failed') console.error(`Factory title sync failed for run ${run.runId}: ${run.titleSync.error}`);
      this.changed(run);
      return;
    }
    else if (msg.kind === 'reply_handles') {
      const entry = this.workers.get(run.runId);
      if (!run.droidSessionId || msg.droidSessionId !== run.droidSessionId
        || !Array.isArray(msg.handles) || !msg.handles.every((handle) => isReplyHandle(handle, run.replyTo))
        || !entry?.approvedReplySends.delete(msg.toolUseId)) return;
      for (const handle of msg.handles) if (!run.replyHandles.includes(handle)) run.replyHandles.push(handle);
      if (msg.handles.length) this.changed(run); // Ownership and its approval proof are durable before inheritance.
      return;
    } else if (msg.kind === 'event') {
      if (msg.event.type === 'permission_approved_once' && msg.event.droidSessionId === run.droidSessionId) {
        const entry = this.workers.get(run.runId);
        if (entry?.persisted.has('submission_intent')) for (const approval of msg.event.puckSendApprovals ?? []) {
          if (approval.recipient === run.replyTo && typeof approval.toolUseId === 'string' && approval.toolUseId.length > 0) entry.approvedReplySends.add(approval.toolUseId);
        }
      } else if (msg.event.type === 'permission_declined') {
        run.permissionsDeclined = (run.permissionsDeclined ?? 0) + 1;
        if (msg.event.reason) run.permissionDenials = [...new Set([...(run.permissionDenials ?? []), msg.event.reason])];
      }
      run.events.push({ at: now(), ...msg.event });
      run.events = run.events.slice(-20);
      if (msg.event.type === 'assistant' && typeof msg.event.text === 'string') {
        run.textTail = (run.textTail + msg.event.text + '\n').slice(-16000);
        run.preview = msg.event.text;
      }
    } else if (msg.kind === 'question') {
      run.questions = [...(run.questions ?? []), ...msg.questions].slice(-10);
    } else if (msg.kind === 'reply') {
      // A failed or misrouted report stays failed; later good reports cannot hide it.
      if (run.reply?.state !== 'failed') run.reply = { state: msg.state, ...(msg.code ? { code: msg.code, message: msg.message } : {}) };
    }
    this.changed(run, { soon: true });
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
    this.changed(run);
    if (entry.child.connected) entry.child.send({ cancel: true }, () => {});
    entry.killTimer ??= setTimeout(() => this.killGroup(entry.child.pid), this.config.cancelGraceMs);
  }

  // Queued turns were never submitted, so dropping them is exact, not a guess.
  cancelRun(run, code = 'cancelled', message = 'Cancelled before it started.') {
    if (run.state === 'queued') {
      this.queue = this.queue.filter((item) => item.run !== run);
      Object.assign(run, { state: 'cancelled', errorCode: code, error: message, cancelRequested: code === 'cancelled', finishedAt: now() });
      this.changed(run);
    } else if (LIVE.has(run.state)) this.stopWorker(run, 'cancel');
  }
  cancelSession(sessionId) {
    for (const run of this.runsOf(this.session(sessionId).sessionId)) this.cancelRun(run);
    this.pump();
    return this.status(sessionId);
  }

  async waitForSessions({ sessions, timeoutSeconds = 30 }, signal) {
    if (new Set(sessions).size !== sessions.length) throw new ToolError('invalid_argument', 'sessions must not contain duplicates');
    for (const id of sessions) this.session(id);
    const settled = () => sessions.every((id) => !isWorking(this.runsOf(id)));
    if (!settled() && timeoutSeconds > 0) {
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); this.changes.off('change', check); signal?.removeEventListener('abort', finish); resolve(); };
        const check = () => { if (settled()) finish(); };
        const timer = setTimeout(finish, timeoutSeconds * 1000);
        this.changes.on('change', check);
        signal?.addEventListener('abort', finish);
      });
    }
    const done = settled();
    return { sessions: sessions.map((id) => this.status(id)), settled: done, timedOut: !done };
  }

  find({ query, state, workspace, labels = [], after, before, archived = false, cursor, limit = 25 }) {
    if (after && before && Date.parse(after) >= Date.parse(before)) throw new ToolError('invalid_argument', 'after must be earlier than before');
    const below = cursorOf(cursor);
    const root = workspace ? approvedWorkspace(this.config, workspace) : null;
    const needle = query?.toLowerCase();
    const matches = Object.values(this.state.sessions).sort((a, b) => b.seq - a.seq).filter((session) => {
      if (below !== null && session.seq >= below) return false;
      if (session.archived !== archived) return false;
      if (root && !contains(root, session.workspace)) return false;
      if (labels.some((label) => !session.labels.includes(label))) return false;
      if (after && Date.parse(session.createdAt) < Date.parse(after)) return false;
      if (before && Date.parse(session.createdAt) >= Date.parse(before)) return false;
      const runs = this.runsOf(session.sessionId);
      if (state && sessionStatus(session, runs).agentState.state !== state) return false;
      if (needle && ![session.title, ...session.labels, ...runs.flatMap((run) => [run.preview, run.textTail])].some((text) => text?.toLowerCase().includes(needle))) return false;
      return true;
    });
    const page = matches.slice(0, limit);
    return { sessions: page.map((session) => sessionStatus(session, this.runsOf(session.sessionId))), nextCursor: matches.length > limit ? String(page.at(-1).seq) : null };
  }

  update({ session: id, title, archived, labels }) {
    const session = this.session(id);
    if (title === undefined && archived === undefined && !labels) throw new ToolError('invalid_argument', 'Provide at least one of title, archived or labels');
    const { add = [], remove = [] } = labels ?? {};
    if (add.some((label) => remove.includes(label))) throw new ToolError('invalid_argument', 'labels.add and labels.remove must not share a label');
    const next = [...new Set([...session.labels.filter((label) => !remove.includes(label)), ...add])].sort();
    if (next.length > 20) throw new ToolError('invalid_argument', 'A session can have at most 20 labels');
    if (archived === true && isWorking(this.runsOf(id))) throw new ToolError('session_busy', 'Cannot archive a session with active or queued turns');
    if (title !== undefined) session.title = title;
    if (archived !== undefined) session.archived = archived;
    if (labels) session.labels = next;
    session.updatedAt = now();
    this.store.save();
    this.changes.emit('change');
    return this.status(id);
  }

  tokenUsageOf(run) {
    if (run.tokenUsage !== undefined) return run.tokenUsage;
    return run.result ? JSON.parse(readFileSync(this.store.resultPath(run.runId), 'utf8')).tokenUsage ?? null : null;
  }
  usage({ session, after, before }) {
    if (after && before && Date.parse(after) >= Date.parse(before)) throw new ToolError('invalid_argument', 'after must be earlier than before');
    const runs = (session ? this.runsOf(this.session(session).sessionId) : Object.values(this.state.runs))
      .filter((run) => submitted(run) && (!after || Date.parse(run.createdAt) >= Date.parse(after)) && (!before || Date.parse(run.createdAt) < Date.parse(before)));
    const usages = runs.map((run) => this.tokenUsageOf(run)).filter(Boolean);
    const credits = usages.filter((usage) => typeof usage.factoryCredits === 'number');
    return {
      session: session ?? null, turns: runs.length, turnsWithUsage: usages.length,
      tokens: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'thinkingTokens'].map((key) => [key, sum(usages, key)])),
      factoryCredits: credits.length ? sum(credits, 'factoryCredits') : null,
    };
  }

  read({ session: id, cursor, limit = 25 }) {
    const session = this.session(id);
    const offset = cursorOf(cursor) ?? 0;
    const messages = [];
    let historyAvailable = true;
    for (const run of this.runsOf(id)) {
      const before = messages.length;
      if (run.result) messages.push(...resultMessages(run, JSON.parse(readFileSync(this.store.resultPath(run.runId), 'utf8'))));
      else if (WORKING.has(run.state)) { if (run.preview) messages.push({ id: `${run.runId}:partial`, runId: run.runId, role: 'assistant', type: 'message', text: run.preview, truncated: false }); }
      else if (submitted(run)) {
        historyAvailable = false;
        if (run.preview) messages.push({ id: `${run.runId}:partial`, runId: run.runId, role: 'assistant', type: 'message', text: run.preview, truncated: false });
        messages.push(noticeMessage(run, `No transcript was retained for this turn (${run.state}).`));
      }
      if (messages.length > before || run.questions?.length || run.permissionsDeclined) messages.push(...turnNotices(run));
    }
    return {
      metadata: this.status(id).metadata, messages: messages.slice(offset, offset + limit),
      nextCursor: offset + limit < messages.length ? String(offset + limit) : null, historyAvailable,
    };
  }

  workspaces() {
    const maximum = this.config.maxConcurrentRuns;
    return {
      workspaces: this.config.approvedDirectories,
      capacity: { maximum, active: this.workers.size, queued: this.queue.length, available: Math.max(0, maximum - this.workers.size) },
      policy: { defaultModel: this.config.defaultModel ?? null, defaultAutonomy: this.config.defaultAutonomy, maxAutonomy: this.config.maxAutonomy, reasoningEffort: this.config.reasoningEffort ?? null, replyBack: Boolean(this.config.ampMcp) },
    };
  }

  async close() {
    this.stopping = true;
    for (const { run } of [...this.queue]) this.cancelRun(run, 'queue_lost', 'Controller shut down before this queued turn started; it was never submitted.');
    for (const id of this.workers.keys()) this.cancelRun(this.state.runs[id]);
    while (this.workers.size) await new Promise((resolve) => setTimeout(resolve, 20));
    this.store.release();
  }
}
