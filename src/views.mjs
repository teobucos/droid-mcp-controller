// Pure projections from durable records to what callers see. Derive, never store:
// agentState, needsAttention, notification and errors are all computed here, and
// Factory/Droid session UUIDs, fingerprints and stderr never appear in the new tools.
import { WORKING } from './store.mjs';
import { describeError } from './errors.mjs';

const PREVIEW = 4000;
const TEXT = 16000;
const DEFAULT_CODE = { failed: 'run_failed', timed_out: 'timed_out', unknown: 'unknown_outcome' };
const DEFAULT_MESSAGE = { failed: 'The turn failed.', timed_out: 'The turn exceeded the run timeout.', unknown: 'The turn outcome is unknown.' };

// SDK, server and OS text can embed ids, paths and URLs (including OAuth fragments).
// Tools return a scrubbed message; raw text stays in local state.
export const scrub = (text) => text
  .replace(/https?:\/\/\S+/g, '<url>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  .replace(/(?:\/[\w.@~+-]+){2,}/g, '<path>')
  .replace(/[\u0000-\u001f]+/g, ' ');

export function runError(run) {
  if (WORKING.has(run.state) || (!run.error && !DEFAULT_CODE[run.state])) return null;
  return describeError(run.errorCode ?? DEFAULT_CODE[run.state] ?? 'run_failed', scrub(run.error ?? DEFAULT_MESSAGE[run.state]).slice(0, 500));
}

// Observed agent-side report: this controller cannot send for the agent, so it
// reports what it saw the agent's amp-puck___puck call do, never more.
export function notification(run) {
  if (!run.replyTo) return { state: 'disabled', error: null };
  if (run.reply) return { state: run.reply.state, error: run.reply.code ? describeError(run.reply.code, run.reply.message) : null };
  return { state: WORKING.has(run.state) ? 'pending' : 'not_sent', error: null };
}

function needsAttention(run, note) {
  if (note.state === 'failed') return true;
  if (WORKING.has(run.state)) return false;
  return ['failed', 'timed_out', 'unknown'].includes(run.state)
    || (run.state === 'interrupted' && !run.cancelRequested)
    || (run.state === 'cancelled' && ['queue_lost', 'predecessor_failed'].includes(run.errorCode))
    || (run.questions?.length ?? 0) > 0 || (run.permissionsDeclined ?? 0) > 0;
}

export const isWorking = (runs) => runs.some((run) => WORKING.has(run.state));

export function sessionStatus(session, runs) {
  const head = runs.find((run) => run.runId === session.headRunId);
  const predecessor = head.errorCode === 'predecessor_failed'
    ? runs.find((run) => run.runId === head.predecessorRunId)
    : null;
  const note = notification(head);
  const state = isWorking(runs) ? 'working' : runs.some((run) => run.state === 'unknown') ? 'unknown' : 'idle';
  const preview = head.preview ?? '';
  return {
    agentState: { state, updatedAt: session.updatedAt },
    metadata: {
      session: session.sessionId, title: session.title, labels: session.labels, archived: session.archived,
      workspace: session.workspace, replyTo: session.replyTo, createdAt: session.createdAt, updatedAt: session.updatedAt,
    },
    preview: { text: preview.slice(-PREVIEW), truncated: preview.length > PREVIEW || head.previewTruncated === true },
    latestRun: {
      runId: head.runId, state: head.state, terminal: !WORKING.has(head.state), needsAttention: needsAttention(head, note),
      autonomy: head.autonomy, model: head.model ?? null, reasoningEffort: head.reasoningEffort ?? null,
      predecessorFailure: predecessor ? { runId: predecessor.runId, state: predecessor.state, error: runError(predecessor) } : null,
      error: runError(head), questions: head.questions ?? [], permissionsDeclined: head.permissionsDeclined ?? 0,
    },
    notification: note,
  };
}

const clip = (text) => ({ text: text.slice(0, TEXT), truncated: text.length > TEXT });
const stringify = (value) => typeof value === 'string' ? value : JSON.stringify(value);

// SDK result messages -> retained history. User messages (the prompts) are never retained.
export function resultMessages(run, result) {
  const out = [];
  (result.messages ?? []).forEach((m, index) => {
    const id = `${run.runId}:${index}`;
    if (m.type === 'assistant' && typeof m.text === 'string' && m.text) out.push({ id, runId: run.runId, role: 'assistant', type: 'message', ...clip(m.text) });
    else if (m.type === 'tool_call') out.push({ id, runId: run.runId, role: 'tool', type: 'tool_call', ...clip(`${m.name} ${stringify(m.input ?? {})}`) });
    else if (m.type === 'tool_result') out.push({ id, runId: run.runId, role: 'tool', type: 'tool_result', ...clip(`${m.isError ? '[error] ' : ''}${stringify(m.content ?? '')}`) });
    else if (m.type === 'error') out.push({ id, runId: run.runId, role: 'controller', type: 'error', ...clip(scrub(String(m.message ?? 'error'))) });
  });
  return out;
}

// Questions and declined permissions are controller facts about a turn, kept in history
// after the head moves on, so a later follow-up cannot hide them.
export function turnNotices(run) {
  const notices = (run.questions ?? []).map((q, index) => ({ id: `${run.runId}:question:${index}`, runId: run.runId, role: 'controller', type: 'notice', ...clip(`Declined AskUser question: ${q.question}${q.options.length ? ` [options: ${q.options.join(' | ')}]` : ''}`) }));
  if (run.permissionsDeclined) notices.push({ id: `${run.runId}:permissions`, runId: run.runId, role: 'controller', type: 'notice', ...clip(`${run.permissionsDeclined} tool permission request(s) were declined by policy${run.permissionDenials?.length ? `: ${run.permissionDenials.join(' ')}` : ''}`) });
  return notices;
}

export function noticeMessage(run, text) {
  return { id: `${run.runId}:notice`, runId: run.runId, role: 'controller', type: 'notice', ...clip(text) };
}
