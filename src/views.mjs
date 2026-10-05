// Pure projections from durable records to what callers see. Derive, never store:
// agentState, needsAttention, notification and errors are all computed here, and
// Factory/Droid session UUIDs, fingerprints and stderr never appear in the new tools.
import { WORKING } from './store.mjs';
import { describeError } from './errors.mjs';

const PREVIEW = 4000;
const TEXT = 16000;
const DEFAULT_CODE = { failed: 'run_failed', timed_out: 'timed_out', unknown: 'unknown_outcome' };
const DEFAULT_MESSAGE = { failed: 'The turn failed.', timed_out: 'The turn exceeded the run timeout.', unknown: 'The turn outcome is unknown.' };

export function runError(run) {
  if (WORKING.has(run.state) || (!run.error && !DEFAULT_CODE[run.state])) return null;
  return describeError(run.errorCode ?? DEFAULT_CODE[run.state] ?? 'run_failed', (run.error ?? DEFAULT_MESSAGE[run.state]).slice(0, 500));
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
    || (run.state === 'cancelled' && run.errorCode === 'queue_lost')
    || (run.questions?.length ?? 0) > 0;
}

export const isWorking = (runs) => runs.some((run) => WORKING.has(run.state));

export function sessionStatus(session, runs) {
  const head = runs.find((run) => run.runId === session.headRunId);
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
      error: runError(head), questions: head.questions ?? [],
    },
    notification: note,
  };
}

const clip = (text) => ({ text: text.slice(0, TEXT), truncated: text.length > TEXT });
const stringify = (value) => typeof value === 'string' ? value : JSON.stringify(value);

// SDK result messages -> retained history. User messages (the prompts) are never retained.
export function resultMessages(run, result) {
  const out = [];
  result.messages.forEach((m, index) => {
    const id = `${run.runId}:${index}`;
    if (m.type === 'assistant' && typeof m.text === 'string' && m.text) out.push({ id, runId: run.runId, role: 'assistant', type: 'message', ...clip(m.text) });
    else if (m.type === 'tool_call') out.push({ id, runId: run.runId, role: 'tool', type: 'tool_call', ...clip(`${m.name} ${stringify(m.input ?? {})}`) });
    else if (m.type === 'tool_result') out.push({ id, runId: run.runId, role: 'tool', type: 'tool_result', ...clip(`${m.isError ? '[error] ' : ''}${stringify(m.content ?? '')}`) });
    else if (m.type === 'error') out.push({ id, runId: run.runId, role: 'controller', type: 'error', ...clip(String(m.message ?? 'error')) });
  });
  return out;
}

export function noticeMessage(run, text) {
  return { id: `${run.runId}:notice`, runId: run.runId, role: 'controller', type: 'notice', ...clip(text) };
}

// Deprecated tools: the original run-shaped view, derived from the same records.
export function legacyRun(run, parentRunId) {
  return {
    runId: run.runId, requestKey: run.requestKey, workspace: run.workspace, autonomy: run.autonomy, model: run.model ?? null,
    ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
    ...(run.replyTo ? { puckConversationId: run.replyTo } : {}),
    parentRunId, createdAt: run.createdAt, updatedAt: run.updatedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    droidSessionId: run.droidSessionId, state: run.state, error: run.error ?? null, cancelRequested: run.cancelRequested ?? false,
    events: run.events, textTail: run.textTail, stderrTail: run.stderrTail, terminal: !WORKING.has(run.state),
  };
}
