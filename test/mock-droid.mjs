#!/usr/bin/env node
// A protocol peer, not a mock of the controller or SDK API.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const home = process.env.MOCK_DROID_HOME;
const audit = process.env.MOCK_AUDIT;
let id, cwd, settings, turnId, timer, prompt;
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

if (process.argv.slice(2).join(' ') !== 'exec --input-format stream-jsonrpc --output-format stream-jsonrpc') process.exit(2);
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(audit, `${JSON.stringify({ ...req, mockPid: process.pid, workerPid: process.ppid })}\n`);
  const p = req.params;
  switch (req.method) {
    case 'droid.initialize_session':
      id = randomUUID(); cwd = p.cwd;
      settings = { modelId: 'mock-model', reasoningEffort: 'off', ...p };
      if (process.env.MOCK_SLOW_INIT === '1') return;
      persist(); reply(req, { sessionId: id, settings, session: { messages: [] } }); break;
    case 'droid.load_session':
      id = p.sessionId;
      ({ cwd, settings } = JSON.parse(readFileSync(`${home}/${id}.json`, 'utf8')));
      if (process.env.MOCK_RESUME_CWD) cwd = process.env.MOCK_RESUME_CWD;
      reply(req, { settings, cwd, session: { messages: [] } }); break;
    case 'droid.update_session_settings':
      settings = { ...settings, ...p }; persist(); reply(req, {}); break;
    case 'droid.add_user_message':
      turnId = p.messageId; prompt = p.text; reply(req, {});
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
      text(`progress:${prompt}`);
      timer = setTimeout(() => {
        const literalReply = prompt.match(/^Reply exactly ([A-Z_]+)\./);
        text(literalReply ? literalReply[1] : `answer:${prompt}`);
        terminal(prompt === 'agent-error' ? 'error' : 'completed');
      }, prompt === 'slow' ? 2500 : 150);
      break;
    case 'droid.interrupt_session':
      clearTimeout(timer); reply(req, {}); terminal('cancelled'); break;
    case 'droid.close_session':
      if (process.env.MOCK_SLOW_CLOSE === '1') return;
      reply(req, {}); break;
    default:
      if (req.id === 'permission-1') {
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
