#!/usr/bin/env node
// A protocol peer, not a mock of the controller or SDK API.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const home = process.env.MOCK_DROID_HOME;
const audit = process.env.MOCK_AUDIT;
let id, cwd, settings, turnId, timer, prompt, toolLists = 0;
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

function profileTools() {
  const names = process.env.MOCK_PUCK_PROFILE ? JSON.parse(readFileSync(process.env.MOCK_PUCK_PROFILE, 'utf8')) : ['puck', 'manage_amp'];
  const ids = names
    .filter((name) => process.env.MOCK_PUCK_FAILURE !== 'unauthenticated' && !(name === 'puck' && process.env.MOCK_PUCK_FAILURE === 'puck-missing'))
    .map((name) => `amp-puck___${name}`);
  if (process.env.MOCK_PUCK_PROFILE) ids.push('Read', 'Execute');
  return ids.map((toolId) => ({
    id: toolId, llmId: toolId, displayName: toolId, description: toolId,
    category: 'read', defaultAllowed: true,
    currentlyAllowed: process.env.MOCK_PUCK_FAILURE === 'admin-allowed' || !settings.disabledToolIds?.includes(toolId),
  }));
}

if (process.argv.slice(2).join(' ') !== 'exec --input-format stream-jsonrpc --output-format stream-jsonrpc') process.exit(2);
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(audit, `${JSON.stringify({ ...req, mockPid: process.pid, workerPid: process.ppid })}\n`);
  const p = req.params;
  switch (req.method) {
    case 'droid.initialize_session':
      if (typeof p.machineId !== 'string') {
        send({ ...envelope('response'), id: req.id, error: { code: -32602, message: 'Required initialize parameter machineId missing' } }); return;
      }
      id = randomUUID(); cwd = p.cwd;
      settings = { modelId: 'mock-model', reasoningEffort: 'off', ...p };
      if (process.env.MOCK_PUCK_PROFILE) settings.disabledToolIds = [...new Set(['Execute', ...(settings.disabledToolIds ?? [])])];
      if (process.env.MOCK_PUCK_FAILURE === 'puck-disabled') settings.disabledToolIds = ['amp-puck___puck'];
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
        persist(); reply(req, { sessionId: id, settings, session: { messages: [] }, ...(catalog.mode === 'missing' ? {} : { [process.env.MOCK_CATALOG_SNAKE === '1' ? 'available_models' : 'availableModels']: catalog }) });
        break;
      }
      persist(); reply(req, { sessionId: id, settings, session: { messages: [] }, availableModels: [] }); break;
    case 'droid.load_session':
      id = p.sessionId;
      ({ cwd, settings } = JSON.parse(readFileSync(`${home}/${id}.json`, 'utf8')));
      if (p.disabledToolIds !== undefined) settings.disabledToolIds = p.disabledToolIds;
      if (process.env.MOCK_RESUME_CWD) cwd = process.env.MOCK_RESUME_CWD;
      reply(req, { settings, cwd, session: { messages: [] } }); break;
    case 'droid.update_session_settings':
      if (p.disabledToolIds && process.env.MOCK_PUCK_FAILURE === 'settings-error') {
        send({ ...envelope('response'), id: req.id, error: { code: -32603, message: 'Mock lockdown settings failure' } }); return;
      }
      settings = { ...settings, ...p }; persist(); reply(req, {}); break;
    case 'droid.list_mcp_servers':
      reply(req, { servers: [{ name: 'amp-puck', status: 'connected', source: 'project', isManaged: false, serverType: 'http', requiresAuth: true, hasAuthTokens: process.env.MOCK_PUCK_FAILURE !== 'unauthenticated' }], summary: { total: 1, connected: 1, connecting: 0, failed: 0 } }); break;
    case 'droid.list_tools': {
      toolLists++;
      if (process.env.MOCK_PUCK_FAILURE === 'discovery-pending') return;
      if (process.env.MOCK_PUCK_FAILURE === 'discovery-error' || (process.env.MOCK_PUCK_FAILURE === 'relist-error' && toolLists > 1)) {
        send({ ...envelope('response'), id: req.id, error: { code: -32603, message: 'Mock tool discovery failure' } }); return;
      }
      const tools = profileTools();
      appendFileSync(audit, `${JSON.stringify({ method: 'mock.tool_inventory', tools, mockPid: process.pid })}\n`);
      reply(req, { tools }); break;
    }
    case 'droid.add_user_message':
      turnId = p.messageId; prompt = p.text; reply(req, {});
      const now = Date.now();
      notify({ type: 'create_message', message: { id: turnId, role: 'user', content: [{ type: 'text', text: prompt }], createdAt: now, updatedAt: now } });
      process.stderr.write('mock diagnostic, separate from assistant output\n');
      notify({ type: 'droid_working_state_changed', newState: 'idle' });
      if (prompt === 'crash') return process.exit(9);
      if (prompt === 'malformed') { process.stdout.write('{invalid json\n'); return; }
      if (prompt === 'silent') return;
      if (prompt === 'wrong-turn') { terminal('completed', randomUUID()); return; }
      if (prompt === 'permission' || prompt === 'permission-once') {
        send({ ...envelope('request'), id: 'permission-1', method: 'droid.request_permission', params: { toolUses: [], options: [...(prompt === 'permission-once' ? [{ label: 'Proceed once', value: 'proceed_once' }] : []), { label: 'Cancel', value: 'cancel' }] } }); return;
      }
      if (prompt === 'ask') {
        send({ ...envelope('request'), id: 'ask-1', method: 'droid.ask_user', params: { toolCallId: 'ask-tool', questions: [{ index: 1, topic: 'Deploy', question: 'Deploy?', options: ['yes', 'no'] }] } }); return;
      }
      if (prompt === 'textless-assistant') {
        const now = Date.now();
        notify({ type: 'create_message', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: randomUUID(), name: 'LS', input: { directory_path: cwd } }], createdAt: now, updatedAt: now } });
      }
      if (!prompt.startsWith('no-echo:')) text(`progress:${prompt}`);
      timer = setTimeout(() => {
        const literalReply = prompt.match(/^Reply exactly ([A-Z_]+)\./);
        text(prompt.startsWith('no-echo:') ? 'Redacted task completed' : literalReply ? literalReply[1] : `answer:${prompt}`);
        terminal(prompt === 'agent-error' ? 'error' : 'completed');
      }, prompt === 'slow' ? 2500 : 150);
      break;
    case 'droid.interrupt_session':
      clearTimeout(timer); reply(req, {}); terminal('cancelled'); break;
    case 'droid.close_session':
      if (process.env.MOCK_SLOW_CLOSE === '1') return;
      reply(req, {}); break;
    default:
      if (req.id === 'catalog-permission') {
        if (req.result.selectedOption !== 'cancel') process.exit(14);
        process.exit(0);
      } else if (req.id === 'permission-1') {
        if (req.result.selectedOption === 'proceed_once' && prompt === 'permission-once') {
          text('single-use permission approved'); terminal('completed');
        } else if (req.result.selectedOption === 'cancel') terminal('permission_rejected');
        else process.exit(12);
      } else if (req.id === 'ask-1') {
        if (!req.result.cancelled) process.exit(13);
        terminal('cancelled');
      } else {
        send({ ...envelope('response'), id: req.id, error: { code: -32601, message: `Unsupported method ${req.method}` } });
      }
  }
});
