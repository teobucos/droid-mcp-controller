#!/usr/bin/env node
// A protocol peer, not a mock of the controller or SDK API.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const home = process.env.MOCK_DROID_HOME;
const audit = process.env.MOCK_AUDIT;
let id, cwd, settings, turnId, timer, prompt, puckRecipient;
let pendingHandleSend, requestedHandle, pendingReplay;
const tokens = { inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 };
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const envelope = (type) => ({ jsonrpc: '2.0', type, factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.245.0' });
const reply = (request, result) => send({ ...envelope('response'), id: request.id, result });
const notify = (notification) => send({ ...envelope('notification'), method: 'droid.session_notification', params: { sessionId: id, notification } });
function terminal(reason, target = turnId) {
  notify({ type: 'agent_turn_completed', turnId: target, reason, tokenUsage: tokens, durationMs: 25 });
}
function text(value) {
  const now = Date.now();
  notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: value }], createdAt: now, updatedAt: now } });
}
function persist() {
  writeFileSync(`${home}/${id}.json`, JSON.stringify({ cwd, settings }));
}

function requestHandleRead(handle, mode) {
  requestedHandle = mode === 'missing' ? undefined : mode === 'foreign' ? handle.replace(/M-.+$/, 'M-abcdefghijkl0123456789') : handle;
  send({ ...envelope('request'), id: 'permission-handle', method: 'droid.request_permission', params: {
    toolUses: [{ toolUse: { type: 'tool_use', id: 'handle-use', name: 'amp-puck___puck', input: { action: 'read_reply', params: requestedHandle === undefined ? {} : { replyHandle: requestedHandle } } }, confirmationType: 'mcp_tool', details: { type: 'mcp_tool', toolName: 'amp-puck___puck', impactLevel: 'low', serverName: 'amp-puck', actualToolName: 'puck' } }],
    options: [{ label: 'Proceed once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }],
  } });
}

function replaySend(saved) {
  const now = Date.now();
  notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [saved.toolUse], createdAt: now, updatedAt: now } });
  notify({ type: 'tool_result', messageId: randomUUID(), toolUseId: saved.toolUse.id, content: saved.body, isError: false });
  requestHandleRead(JSON.parse(saved.body).replyHandle);
}

if (process.argv.slice(2).join(' ') !== 'exec --input-format stream-jsonrpc --output-format stream-jsonrpc') process.exit(2);
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(audit, `${JSON.stringify({ ...req, ts: Date.now(), mockPid: process.pid, workerPid: process.ppid })}\n`);
  const p = req.params;
  switch (req.method) {
    case 'droid.initialize_session':
      if (typeof p.machineId !== 'string') {
        send({ ...envelope('response'), id: req.id, error: { code: -32602, message: 'Required initialize parameter machineId missing' } }); return;
      }
      id = randomUUID(); cwd = p.cwd;
      settings = { modelId: 'mock-model', reasoningEffort: 'off', ...p };
      if (process.env.MOCK_SLOW_INIT === '1') return;
      // Catalog fixtures are used only by the transient probe in controller state
      // cwd, so sparse/raw catalog fixtures do not alter turn-execution tests.
      if (cwd.endsWith('/state') && existsSync(`${home}/catalog.json`)) {
        const catalog = JSON.parse(readFileSync(`${home}/catalog.json`, 'utf8'));
        if (catalog.mode === 'hang') return;
        if (catalog.mode === 'permission') {
          send({ ...envelope('request'), id: 'catalog-permission', method: 'droid.request_permission', params: { toolUses: [], options: [{ label: 'Proceed once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }] } });
          return;
        }
        if (catalog.error) {
          send({ ...envelope('response'), id: req.id, error: { code: -32000, message: catalog.error } }); return;
        }
        persist(); reply(req, { sessionId: id, settings, session: { messages: [] }, ...(catalog.mode === 'missing' ? {} : { availableModels: catalog }) });
        if (process.env.MOCK_CATALOG_UNRELATED === '1') reply({ id: 'unrelated-response' }, { sessionId: randomUUID(), availableModels: [{ id: 'poison', displayName: 'Unrelated' }] });
        break;
      }
      persist(); reply(req, { sessionId: id, settings, session: { messages: [] }, availableModels: [] }); break;
    case 'droid.load_session':
      id = p.sessionId;
      ({ cwd, settings } = JSON.parse(readFileSync(`${home}/${id}.json`, 'utf8')));
      if (process.env.MOCK_RESUME_CWD) cwd = process.env.MOCK_RESUME_CWD;
      reply(req, { settings, cwd, session: { messages: [] } }); break;
    case 'droid.update_session_settings':
      if (p.disabledToolIds && process.env.MOCK_PUCK_FAILURE === 'settings-error') {
        send({ ...envelope('response'), id: req.id, error: { code: -32603, message: 'settings failure' } }); break;
      }
      settings = { ...settings, ...p }; persist(); reply(req, {}); break;
    case 'droid.list_mcp_tools':
      if (['unlisted', 'archived', 'alias-blind'].includes(process.env.MOCK_PUCK_FAILURE)) { reply(req, { tools: [] }); break; }
      reply(req, { tools: ['puck', 'manage_amp', 'find_thread', 'read_thread', ...(['new-tool', 'undeniable', 'alias'].includes(process.env.MOCK_PUCK_FAILURE) ? ['brand_new_tool'] : [])].map((name) => ({ serverName: 'amp-puck', name, isEnabled: true })) }); break;
    case 'droid.list_mcp_servers':
      if (process.env.MOCK_PUCK_FAILURE === 'leaky') {
        reply(req, { servers: [{ name: 'amp-puck', status: 'failed', error: 'boom 11111111-2222-4333-8444-555555555555 at /home/box/.factory/private/x https://example.invalid/cb#state=SECRETSTATE', source: 'project', isManaged: false, serverType: 'http', requiresAuth: true, hasAuthTokens: true }], summary: { total: 1, connected: 0, connecting: 0, failed: 1 } }); break;
      }
      if (process.env.MOCK_PUCK_FAILURE === 'unlisted') { reply(req, { servers: [], summary: { total: 0, connected: 0, connecting: 0, failed: 0 } }); break; }
      if (process.env.MOCK_PUCK_FAILURE === 'archived') {
        reply(req, { servers: [{ name: 'amp-puck', status: 'failed', error: 'Error POSTing to endpoint: {"error":"This thread is archived"}', source: 'project', isManaged: false, serverType: 'http', requiresAuth: true, hasAuthTokens: true }], summary: { total: 1, connected: 0, connecting: 0, failed: 1 } }); break;
      }
      reply(req, { servers: [{ name: 'amp-puck', status: 'connected', source: 'project', isManaged: false, serverType: 'http', requiresAuth: true, hasAuthTokens: process.env.MOCK_PUCK_FAILURE !== 'unauthenticated' }], summary: { total: 1, connected: 1, connecting: 0, failed: 0 } }); break;
    case 'droid.list_tools':
      if (process.env.MOCK_PUCK_FAILURE === 'discovery-pending') return;
      if (process.env.MOCK_PUCK_FAILURE === 'discovery-error') {
        send({ ...envelope('response'), id: req.id, error: { code: -32603, message: 'discovery failure' } }); break;
      }
      if (['archived', 'unlisted'].includes(process.env.MOCK_PUCK_FAILURE)) {
        send({ ...envelope('response'), id: req.id, error: { code: -32000, message: 'Unknown tool identifier(s): amp-puck___manage_amp' } }); break;
      }
      {
        const tools = ['puck', 'manage_amp', 'find_thread', 'read_thread', ...(['new-tool', 'undeniable', 'alias', 'alias-blind'].includes(process.env.MOCK_PUCK_FAILURE) ? ['brand_new_tool'] : [])].filter((name) => process.env.MOCK_PUCK_FAILURE !== 'unauthenticated' && !(name === 'puck' && process.env.MOCK_PUCK_FAILURE === 'puck-missing')).map((name) => ({ id: `amp-puck___${name}`, llmId: ['alias', 'alias-blind'].includes(process.env.MOCK_PUCK_FAILURE) && name === 'brand_new_tool' ? name : `amp-puck___${name}`, displayName: name, description: name, category: 'read', defaultAllowed: true, currentlyAllowed: process.env.MOCK_PUCK_FAILURE === 'admin-allowed' || (process.env.MOCK_PUCK_FAILURE === 'undeniable' && name === 'brand_new_tool') || !settings.disabledToolIds?.includes(`amp-puck___${name}`) }));
        tools.push(...['Read', 'Execute'].map((name) => ({ id: name, llmId: name, displayName: name, description: name, category: 'read', defaultAllowed: true, currentlyAllowed: !settings.disabledToolIds?.includes(name) })));
        appendFileSync(audit, `${JSON.stringify({ method: 'mock.tool_inventory', tools, mockPid: process.pid })}\n`);
        reply(req, { tools }); break;
      }
    case 'droid.add_user_message':
      turnId = p.messageId; const text0 = p.text; prompt = p.text.split('\n\n[Controller coordination context]')[0]; reply(req, {});
      const now = Date.now();
      notify({ type: 'create_message', message: { id: turnId, role: 'user', content: [{ type: 'text', text: prompt }], createdAt: now, updatedAt: now } });
      process.stderr.write('mock diagnostic, separate from assistant output\n');
      notify({ type: 'droid_working_state_changed', newState: 'idle' });
      if (prompt === 'crash') return process.exit(9);
      if (prompt === 'malformed') { process.stdout.write('{invalid json\n'); return; }
      if (prompt === 'silent') return;
      if (prompt === 'wrong-turn') { terminal('completed', randomUUID()); return; }
      if (['replay-historical-send', 'replay-other-approval', 'replay-foreign-approval'].includes(prompt)) {
        pendingReplay = JSON.parse(readFileSync(`${home}/${id}.send.json`, 'utf8'));
        if (prompt === 'replay-historical-send') { replaySend(pendingReplay); return; }
        const toolUse = { ...pendingReplay.toolUse, id: prompt === 'replay-other-approval' ? randomUUID() : pendingReplay.toolUse.id,
          input: { action: 'send', params: { ...pendingReplay.toolUse.input.params, ...(prompt === 'replay-foreign-approval' ? { conversationID: 'T-99999999-9999-4999-8999-999999999999' } : {}) } } };
        send({ ...envelope('request'), id: 'permission-replay-send', method: 'droid.request_permission', params: {
          toolUses: [{ toolUse, confirmationType: 'mcp_tool', details: { type: 'mcp_tool', toolName: 'amp-puck___puck', impactLevel: 'low', serverName: 'amp-puck', actualToolName: 'puck' } }],
          options: [{ label: 'Proceed once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }],
        } });
        return;
      }
      if (prompt.startsWith('puck-handle:')) {
        const mode = prompt.slice('puck-handle:'.length);
        const recipient = text0.match(/conversationID: (T-[0-9a-f-]{36})/)?.[1];
        const handle = `v1:${recipient}:M-${randomUUID().replaceAll('-', '').slice(0, 22)}`;
        if (!['missing', 'stale'].includes(mode)) {
          const sentTo = mode === 'misrouted' ? 'T-99999999-9999-4999-8999-999999999999' : recipient;
          const toolUseId = randomUUID();
          const toolUse = { type: 'tool_use', id: toolUseId, name: 'amp-puck___puck', input: { action: 'send', params: { conversationID: sentTo, message: 'fixture checkpoint' } } };
          notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [toolUse], createdAt: now, updatedAt: now } });
          pendingHandleSend = { mode, sentTo, toolUseId, handle };
          send({ ...envelope('request'), id: 'permission-handle-send', method: 'droid.request_permission', params: {
            toolUses: [{ toolUse, confirmationType: 'mcp_tool', details: { type: 'mcp_tool', toolName: 'amp-puck___puck', impactLevel: 'low', serverName: 'amp-puck', actualToolName: 'puck' } }],
            options: [{ label: 'Proceed once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }],
          } }); return;
        }
        requestHandleRead(handle, mode); return;
      }
      if (prompt.startsWith('puck-read:')) { requestHandleRead(prompt.slice('puck-read:'.length)); return; }
      if (prompt === 'permission' || prompt === 'permission-once') {
        send({ ...envelope('request'), id: 'permission-1', method: 'droid.request_permission', params: { toolUses: [], options: [...(prompt === 'permission-once' ? [{ label: 'Proceed once', value: 'proceed_once' }] : []), { label: 'Cancel', value: 'cancel' }] } }); return;
      }
      if (prompt === 'leaky-error') {
        notify({ type: 'error', message: 'boom 11111111-2222-4333-8444-555555555555 /private/mock/.factory/token https://example.invalid/callback#state=MOCK_ONLY', errorType: 'Error', timestamp: new Date().toISOString() });
      }
      if (prompt.startsWith('puck-permission')) {
        const recipient = puckRecipient = prompt === 'puck-permission-wrong' ? 'T-99999999-9999-4999-8999-999999999999' : text0.match(/conversationID: (T-[0-9a-f-]{36})/)?.[1];
        send({ ...envelope('request'), id: 'permission-puck', method: 'droid.request_permission', params: { toolUses: [{ toolUse: { type: 'tool_use', id: 'puck-tool-use', name: 'amp-puck___puck', input: { action: 'send', params: { conversationID: recipient, message: 'mock report' } } }, confirmationType: 'mcp_tool', details: { type: 'mcp_tool', toolName: 'amp-puck___puck', impactLevel: 'low', serverName: 'amp-puck', actualToolName: 'puck' } }], options: [{ label: 'Proceed once', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }] } }); return;
      }
      if (prompt === 'ask') {
        send({ ...envelope('request'), id: 'ask-1', method: 'droid.ask_user', params: { toolCallId: 'ask-tool', questions: [{ index: 1, topic: 'Deploy', question: 'Deploy?', options: ['yes', 'no'] }] } }); return;
      }
      if (prompt === 'textless-assistant') {
        const now = Date.now();
        notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: randomUUID(), name: 'LS', input: { directory_path: cwd } }], createdAt: now, updatedAt: now } });
      }
      if (/^puck-(report|wrong|error)/.test(prompt)) {
        const recipient = prompt.startsWith('puck-wrong') ? 'T-99999999-9999-4999-8999-999999999999' : text0.match(/conversationID: (T-[0-9a-f-]{36})/)?.[1];
        const toolUseId = randomUUID();
        const at = Date.now();
        notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'amp-puck___puck', input: { action: 'send', params: { conversationID: recipient, message: 'mock report' } } }], createdAt: at, updatedAt: at } });
        notify({ type: 'tool_result', messageId: randomUUID(), toolUseId, content: prompt.startsWith('puck-error') ? 'rejected' : 'accepted', isError: prompt.startsWith('puck-error') });
        if (prompt === 'puck-report-read') {
          const readId = randomUUID();
          notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: readId, name: 'amp-puck___puck', input: { action: 'read_reply', params: { replyHandle: 'handle-1' } } }], createdAt: at, updatedAt: at } });
          notify({ type: 'tool_result', messageId: randomUUID(), toolUseId: readId, content: 'no reply yet', isError: false });
        }
      }
      if (!prompt.startsWith('no-echo:')) text(`progress:${prompt}`);
      timer = setTimeout(() => {
        const literalReply = prompt.match(/^Reply exactly ([A-Z_]+)\./);
        text(prompt.startsWith('no-echo:') ? 'Redacted task completed' : literalReply ? literalReply[1] : `answer:${prompt}`);
        terminal(prompt === 'agent-error' ? 'error' : 'completed');
      }, prompt === 'slow' ? 2500 : prompt.startsWith('sleep:') ? Number(prompt.slice(6).split(' ')[0]) : 150);
      break;
    case 'droid.interrupt_session':
      if (process.env.MOCK_IGNORE_INTERRUPT === '1') return;
      clearTimeout(timer); reply(req, {}); terminal('cancelled'); break;
    case 'droid.close_session':
      if (process.env.MOCK_SLOW_CLOSE === '1' && !cwd.endsWith('/state')) return;
      reply(req, {}); break;
    default:
      if (req.id === 'permission-replay-send') {
        replaySend(pendingReplay);
      } else if (req.id === 'permission-handle-send') {
        const { mode, sentTo, toolUseId, handle } = pendingHandleSend;
        const body = JSON.stringify({ status: 'queued', conversationID: sentTo, replyHandle: handle });
        writeFileSync(`${home}/${id}.send.json`, JSON.stringify({ toolUse: { type: 'tool_use', id: toolUseId, name: 'amp-puck___puck', input: { action: 'send', params: { conversationID: sentTo, message: 'fixture checkpoint' } } }, body }));
        notify({ type: 'tool_result', messageId: randomUUID(), toolUseId, content: mode === 'blocks' ? [{ type: 'text', text: body }] : body, isError: mode === 'failed' || req.result.selectedOption !== 'proceed_once' });
        // Same stdout batch: observation must beat the following permission RPC.
        requestHandleRead(handle, mode);
      } else if (req.id === 'permission-handle') {
        if (req.result.selectedOption === 'proceed_once') {
          const now = Date.now();
          notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: 'handle-use', name: 'amp-puck___puck', input: { action: 'read_reply', params: { replyHandle: requestedHandle } } }], createdAt: now, updatedAt: now } });
          notify({ type: 'tool_result', messageId: randomUUID(), toolUseId: 'handle-use', content: JSON.stringify({ status: 'completed', replyHandle: requestedHandle, reply: 'DELAYED_ACK' }), isError: false });
          text('DELAYED_ACK'); terminal('completed');
        } else { text(req.result.comment ?? 'permission denied'); terminal('permission_rejected'); }
      } else if (req.id === 'catalog-permission') {
        if (req.result.selectedOption !== 'cancel') process.exit(14);
        process.exit(0);
      } else if (req.id === 'permission-1') {
        if (req.result.selectedOption === 'proceed_once' && prompt === 'permission-once') {
          text('single-use permission approved'); terminal('completed');
        } else if (req.result.selectedOption === 'cancel') terminal('permission_rejected');
        else process.exit(12);
      } else if (req.id === 'permission-puck') {
        if (req.result.selectedOption === 'proceed_once') {
          const toolUseId = randomUUID();
          const at = Date.now();
          notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'amp-puck___puck', input: { action: 'send', params: { conversationID: puckRecipient, message: 'mock report' } } }], createdAt: at, updatedAt: at } });
          notify({ type: 'tool_result', messageId: randomUUID(), toolUseId, content: 'accepted', isError: false });
          text('puck permission approved'); terminal('completed');
        } else terminal('permission_rejected');
      } else if (req.id === 'ask-1') {
        if (!req.result.cancelled) process.exit(13);
        terminal('cancelled');
      } else {
        send({ ...envelope('response'), id: req.id, error: { code: -32601, message: `Unsupported method ${req.method}` } });
      }
  }
});
