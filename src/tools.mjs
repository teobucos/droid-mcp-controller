// Eleven session tools. This is the single source for schemas and descriptions;
// docs/TOOLS.md is generated from it.
import { z } from 'zod';
import { autonomy, reasoning } from './config.mjs';
import { RUN_STATES } from './store.mjs';

const nonBlank = /\S/;
const uuid = z.string().uuid();
const requestKey = z.string().min(1).max(200).regex(nonBlank, 'must not be blank').describe('Idempotency key. Reuse it only with exactly the same arguments; it is global to this controller.');
const text = z.string().min(1).max(100000).regex(nonBlank, 'must not be blank');
const title = z.string().min(1).max(256).regex(nonBlank, 'must not be blank');
const label = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'labels are lowercase letters, digits and hyphens');
const labels = z.array(label).max(20);
const model = z.string().min(1).max(200).regex(nonBlank, 'must not be blank');
const replyTo = z.string().regex(/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'replyTo must be a Puck conversation id like T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, or null');
const iso = z.string().datetime({ offset: true, message: 'must be an ISO 8601 date-time, e.g. 2026-10-01T00:00:00Z' })
  .refine((value) => Number.isFinite(Date.parse(value)), 'must be a real date-time with a valid UTC offset');
const cursor = z.string().min(1).max(512);
const limit = (fallback) => z.number().int().min(1).max(100).default(fallback);
const session = uuid.describe('Session handle from droid_create_session or droid_find_sessions.');
const settings = (scope) => ({
  reasoningEffort: reasoning.optional().describe(`Independent of autonomy. An explicit value must be supported by the selected model. Omitted: ${scope === 'create' ? '' : "the session's last effort when the model is unchanged and still supports it, otherwise "}the host reasoningEffort if the model supports it, otherwise the model's live default.`),
  autonomy: autonomy.optional().describe(`off = read-only Spec mode; low|medium|high = Auto at that level. An explicit value above the host ceiling is rejected. Omitted: ${scope === 'create' ? 'the host defaultAutonomy' : "the session's last accepted autonomy, capped at the current ceiling (never raised to the host default)"}.`),
});

// ---- output shapes (shared by every tool that returns a session) -----------
const errorShape = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), action: z.string() });
export const statusShape = z.object({
  agentState: z.object({ state: z.enum(['working', 'idle', 'unknown']).describe('working = a turn is queued or running; idle = nothing queued or running (not a success claim); unknown = the controller stopped mid-turn'), updatedAt: z.string() }),
  metadata: z.object({ session: z.string(), title: z.string(), labels: z.array(z.string()), archived: z.boolean(), workspace: z.string(), replyTo: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }),
  preview: z.object({ text: z.string(), truncated: z.boolean() }),
  latestRun: z.object({
    runId: z.string(), state: z.enum(RUN_STATES), terminal: z.boolean(), needsAttention: z.boolean(),
    autonomy: z.string(), model: z.string().nullable(), reasoningEffort: z.string().nullable(),
    predecessorFailure: z.object({ runId: z.string(), state: z.enum(RUN_STATES), error: errorShape.nullable() }).nullable().describe('Failed predecessor that caused this queued turn to be dropped; null for other turns.'),
    error: errorShape.nullable(), permissionsDeclined: z.number().describe('Tool permissions the controller declined this turn (anything above the autonomy policy). The SDK may still report success after a declined tool, so check this before trusting the output'), questions: z.array(z.object({ question: z.string(), options: z.array(z.string()) })).describe('AskUser questions the agent asked and the controller declined; answer them with droid_send_message'),
  }),
  notification: z.object({ state: z.enum(['disabled', 'pending', 'accepted', 'failed', 'not_sent']).describe('Observed agent-side report to replyTo: disabled = detached; pending = turn still running; accepted = the Amp MCP accepted a report (not proof Puck read it); failed = a report was rejected or misrouted; not_sent = the turn ended without a report'), error: errorShape.nullable() }),
});
const dispositionShape = z.enum(['started', 'queued', 'interrupting']);
const messageShape = z.object({ id: z.string(), runId: z.string(), role: z.enum(['assistant', 'tool', 'controller']), type: z.enum(['message', 'tool_call', 'tool_result', 'error', 'notice']), text: z.string(), truncated: z.boolean() });
const tokens = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheCreationTokens: z.number(), thinkingTokens: z.number() });

export function defineTools(controller, models) {
  const tool = (name, description, input, output, run, readOnly = false) => ({ name, description, input, output, run, readOnly });

  return [
    tool('droid_create_session',
      'Create a Droid session in an approved local workspace and start its first turn. Use it to delegate a new task; use droid_send_message for follow-ups and droid_wait_for_sessions to join work. ' +
      'Returns immediately with the session status (agentState, metadata, preview, latestRun, notification); latestRun.state is queued while capacity or a workspace lock is busy, and the task is submitted only when it starts. ' +
      'replyTo is required: a Puck conversation id (T-...) gives the agent a reply-back route, null means detached work that never needs Amp; no recipient is ever inferred. ' +
      'model is optional: omit it to use the host defaultModel (policy.defaultModel in droid_list_workspaces, validated against the live catalog and never a Fast variant), or pass an id from droid_models. Autonomy and reasoning default to the host policy; use autonomy off for read-only work. latestRun reports the effective model, autonomy and reasoning. ' +
      "Example: {requestKey:'review-42', workspace:'/approved/repo', prompt:'Review the diff and report findings.', replyTo:null, autonomy:'off', title:'Diff review', labels:['review']}. " +
      'Reuse requestKey only with identical arguments; a replay returns the original acceptance and its original settings even if host defaults changed. Rejects with an actionable code for unapproved workspaces (new projects need one-time operator approval), model_required when no model or host default exists, unknown models, unsupported reasoning, autonomy above the ceiling, and replyTo when reply-back is not configured. Local workspaces only: no remote executors or automatic worktrees.',
      z.object({
        requestKey, workspace: z.string().min(1).max(4096).describe('Absolute path inside an approved root (see droid_list_workspaces).'), prompt: text,
        model: model.optional().describe('Model id from droid_models. Omitted: the host defaultModel; rejected with model_required when none is configured.'),
        replyTo: replyTo.nullable().describe('Puck conversation id to report to, or null for detached work. Required; never defaulted.'),
        title: title.optional(), labels: labels.optional().describe('Lowercase labels for droid_find_sessions.'), ...settings('create'),
      }).strict(), statusShape,
      (args) => controller.create(args)),

    tool('droid_send_message',
      'Send a follow-up to a Droid session, or steer it. Returns immediately with runId, disposition (started | queued | interrupting) and the session status. ' +
      'An idle session starts the message at once. A busy session queues it after the current turn by default (interrupt:false), so unlike Puck\'s Amp thread messages this does not interrupt by default; mid-run steering needs interrupt:true. ' +
      'interrupt:true durably supersedes older queued turns on this session (cancelled with code superseded), interrupts the active turn, waits for process cleanup and workspace admission, then runs your message in the same Droid session. It is not native in-flight injection, and interrupted tool side effects are not undone. ' +
      "Omitted model and autonomy inherit the session's last accepted turn (including queued work), with autonomy capped at the current ceiling; omitted reasoning follows the same-model rule on reasoningEffort; the status latestRun reports the effective settings. Pass a value only to change it. Example: {session:'SESSION_ID', requestKey:'review-42-next', message:'Focus on authorization errors.'}; steering: add interrupt:true. " +
      'replyTo is optional: omit it to keep the session recipient, pass a Puck conversation id to retarget, or null to detach. A normal message restores an archived session. ' +
      'Duplicate requestKeys return the original acceptance; changed intent, an unknown outcome (controller crashed mid-turn), too many queued turns, unknown models, unsupported explicit reasoning and explicit autonomy above the ceiling reject with an actionable code (never a silent downgrade). Queued messages live in memory and are not replayed after a controller restart.',
      z.object({ session, requestKey, message: text, model: model.optional().describe("Model id from droid_models. Omitted: the session's last accepted model (not the host default)."), interrupt: z.boolean().default(false).describe('false (default) queues after the current turn; true supersedes older queued turns and interrupts the active turn first.'), replyTo: replyTo.nullable().optional(), ...settings('send') }).strict(),
      z.object({ runId: z.string(), disposition: dispositionShape, status: statusShape }),
      ({ message, ...args }) => controller.send({ ...args, prompt: message })),

    tool('droid_get_session_status',
      'Get a Droid session\'s agentState, metadata, output preview, latest run outcome (including declined AskUser questions) and observed reply-back notification. Use it for a quick progress check; use droid_read_session for history and droid_wait_for_sessions to join. ' +
      'Example: {session:\'SESSION_ID\'}. idle means nothing is queued or running, not that the task succeeded: check latestRun.state and needsAttention (set for failures, unknown outcomes, declined permissions or questions, and failed reports). ' +
      'unknown means the controller stopped mid-turn; work was not replayed and the session cannot continue until you inspect it. Does not start Droid or change state. An unknown session rejects with unknown_session.',
      z.object({ session }).strict(), statusShape, ({ session: id }) => controller.status(id), true),

    tool('droid_read_session',
      'Read paginated history for a Droid session without resuming or changing it. Returns metadata, messages (assistant text, tool calls and results, controller notices), nextCursor and historyAvailable; follow nextCursor until null. ' +
      'Example: {session:\'SESSION_ID\', limit:25}. Your prompts are never retained, so no user messages appear; a running turn shows only its latest partial text. History may contain sensitive task content. ' +
      'historyAvailable:false means at least one turn has no retained transcript (for example it crashed); nothing is invented. Invalid cursors reject with invalid_cursor. To ask a question about the history, send a message to the session or create a new one.',
      z.object({ session, cursor: cursor.optional(), limit: limit(25).optional() }).strict(),
      z.object({ metadata: statusShape.shape.metadata, messages: z.array(messageShape), nextCursor: z.string().nullable(), historyAvailable: z.boolean() }),
      (args) => controller.read(args), true),

    tool('droid_wait_for_sessions',
      'Wait for up to ten Droid sessions to settle, then return their status in input order. A session is settled when it has no queued or running turn; that includes finished, failed, cancelled and unknown outcomes and anything that needsAttention, so you are never left blocked. ' +
      "Example: {sessions:['SESSION_ID'], timeoutSeconds:30}. Returns settled (all settled) and timedOut; a timeout is not failure and never cancels work, so repeat the wait for longer joins. " +
      'Always inspect latestRun.state, needsAttention and notification before treating a settled session as successful. Sessions must be distinct and known; unknown handles reject before waiting. Disconnecting stops only the wait.',
      z.object({ sessions: z.array(uuid).min(1).max(10), timeoutSeconds: z.number().int().min(0).max(60).default(30).optional() }).strict(),
      z.object({ sessions: z.array(statusShape), settled: z.boolean(), timedOut: z.boolean() }),
      (args, { signal }) => controller.waitForSessions(args, signal), true),

    tool('droid_find_sessions',
      'Find Droid sessions with text and typed filters, newest created first. Returns sessions (same shape as droid_get_session_status) and nextCursor; pass the cursor with unchanged filters for the next page. ' +
      "Example: {query:'authorization', state:'idle', labels:['review'], limit:25}. Filters combine with AND; labels requires every label. query is a case-insensitive text match over title, labels and the last part of each turn's output (the controller keeps a bounded preview and tail, not full transcripts; use droid_read_session for full history). Prompts are never searched. " +
      'workspace includes sessions in descendants of that approved directory. after is inclusive and before exclusive, by creation time. Archived sessions are hidden unless archived:true selects archived only. A newer session never shifts later pages. Invalid ranges and cursors reject.',
      z.object({ query: z.string().min(1).max(1000).regex(nonBlank, 'must not be blank').optional(), state: z.enum(['working', 'idle', 'unknown']).optional(), workspace: z.string().min(1).max(4096).optional(), labels: labels.optional(), after: iso.optional(), before: iso.optional(), archived: z.boolean().default(false).optional(), cursor: cursor.optional(), limit: limit(25).optional() }).strict(),
      z.object({ sessions: z.array(statusShape), nextCursor: z.string().nullable() }),
      (args) => controller.find(args), true),

    tool('droid_update_session',
      'Update a Droid session\'s title, labels or archive state and return its status. Change only metadata the owner asked for. ' +
      "Example: {session:'SESSION_ID', title:'Authorization review', labels:{add:['review'], remove:['draft']}}. Label changes are incremental; archived:true hides the session from droid_find_sessions without deleting anything and archived:false restores it. " +
      'Does not cancel work, change routing or alter model settings. An empty update, conflicting labels, more than 20 labels and archiving a session with queued or running turns reject.',
      z.object({ session, title: title.optional(), archived: z.boolean().optional(), labels: z.object({ add: labels.optional(), remove: labels.optional() }).strict().optional() }).strict(),
      statusShape, (args) => controller.update(args)),

    tool('droid_cancel_session',
      'Cancel a Droid session: interrupt its running turn and drop its queued follow-ups. Returns the status immediately; wait for the session to settle before reusing its workspace. ' +
      "Example: {session:'SESSION_ID'}. Cancellation asks Droid to interrupt and falls back to terminating the owned process group after the grace period. It does not undo edits, delete history or rewrite a finished outcome, and other sessions are untouched. Repeating it is safe; an unknown session rejects.",
      z.object({ session }).strict(), statusShape, ({ session: id }) => controller.cancelSession(id)),

    tool('droid_get_usage',
      'Get token usage for one Droid session, or for every controller turn when session is omitted. Returns turns, turnsWithUsage, summed token counts and factoryCredits (null when Factory reported none). ' +
      "Example: {session:'SESSION_ID'} or {after:'2026-10-01T00:00:00Z', before:'2026-11-01T00:00:00Z'}. Dates filter turn creation time, after inclusive and before exclusive. Each potentially submitted turn counts once (durable submission intent or unknown outcome is not proof of Factory acceptance; queued cancellations are not counted); retries with the same requestKey are not double counted. " +
      'Missing usage is never counted as zero credits or guessed in dollars. Makes no model or billing call. Unknown sessions and invalid ranges reject.',
      z.object({ session: uuid.optional(), after: iso.optional(), before: iso.optional() }).strict(),
      z.object({ session: z.string().nullable(), turns: z.number(), turnsWithUsage: z.number(), tokens, factoryCredits: z.number().nullable() }),
      (args) => controller.usage(args), true),

    tool('droid_list_workspaces',
      'List this controller\'s approved local workspace roots, execution capacity and launch policy. Use it before creating work. ' +
      'Example: {}. Returns workspaces (the roots; a launch restriction, not an OS sandbox), capacity {maximum, active, queued, available} and policy {defaultModel, defaultAutonomy, maxAutonomy, reasoningEffort, replyBack}. ' +
      'A free slot does not skip workspace locks: a writer (autonomy above off) needs its whole canonical tree to itself, readers (off) may share, and conflicting turns queue FIFO. Execution is local to this host: no orbs, remote machines or other runners.',
      z.object({}).strict(),
      z.object({ workspaces: z.array(z.string()), capacity: z.object({ maximum: z.number(), active: z.number(), queued: z.number(), available: z.number() }), policy: z.object({ defaultModel: z.string().nullable(), defaultAutonomy: z.string(), maxAutonomy: z.string(), reasoningEffort: z.string().nullable(), replyBack: z.boolean() }) }),
      () => controller.workspaces(), true),

    tool('droid_models',
      'List the models currently available to this controller\'s authenticated Factory account and organization. Pass a returned id as model to choose or change a model (omitted, create uses the host defaultModel and send keeps the session model); never guess ids from CLI help or old sessions. ' +
      'Example: {}. Returns fetchedAt and models excluding disabled:true and deprecated:true, with reasoning, lifecycle and media metadata only when Factory supplies them. Missing deprecated metadata means lifecycle is unknown, not proven non-legacy. Concurrent calls share one bounded cache refresh and no task prompt is submitted. ' +
      'A failed refresh returns model_discovery_failed, never an expired catalog presented as current. Pricing is never fabricated.',
      z.object({}).strict(),
      z.object({ fetchedAt: z.string(), models: z.array(z.object({ id: z.string(), displayName: z.string(), deprecated: z.boolean().optional(), provider: z.string().optional(), supportedReasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(), supportsImages: z.boolean().optional(), supportsPdfs: z.boolean().optional() })) }),
      () => models.get(), true),
  ];
}
