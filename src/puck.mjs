// Capabilities come from observed tool results, never assistant prose or prompts.
export const PUCK_TOOL = 'amp-puck___puck';

export const isReplyHandle = (handle, recipient) => typeof handle === 'string' && Boolean(recipient)
  && handle.match(/^v1:(T-[0-9a-f-]{36}):M-[0-9A-Za-z]{22}$/)?.[1] === recipient;

export function replyHandlesFromContent(content, recipient) {
  // SDK 0.9.1 retains strings or MCP text blocks. Unknown formats fail closed.
  const texts = typeof content === 'string' ? [content] : Array.isArray(content)
    ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text) : [];
  const handles = new Set();
  for (const text of texts) {
    let result;
    try { result = JSON.parse(text); } catch { continue; }
    if (isReplyHandle(result?.replyHandle, recipient) && (result.conversationID === undefined || result.conversationID === recipient)) handles.add(result.replyHandle);
  }
  return [...handles];
}

// Backfill old prompt-free records only with run-local, controller-observed
// permission provenance AND the corresponding successful SDK call/result pair.
// A historical send copied into a later turn's transcript is not new ownership.
export function legacyReplyHandles(run, result) {
  const approved = new Set();
  for (const event of run.events) {
    if (event.type !== 'permission_approved_once') continue;
    let request;
    try { request = JSON.parse(event.details); } catch { continue; }
    if (!Array.isArray(request?.toolUses)) continue;
    for (const { toolUse, confirmationType } of request.toolUses) {
      if (confirmationType === 'mcp_tool' && toolUse?.name === PUCK_TOOL && toolUse.input?.action === 'send'
        && toolUse.input?.params?.conversationID === run.replyTo && typeof toolUse.id === 'string') approved.add(toolUse.id);
    }
  }
  const sends = new Set();
  const handles = new Set();
  for (const message of result.messages) {
    if (message.type === 'tool_call' && approved.has(message.toolUseId) && message.name === PUCK_TOOL
      && message.input?.action === 'send' && message.input?.params?.conversationID === run.replyTo) sends.add(message.toolUseId);
    else if (message.type === 'tool_result' && sends.delete(message.toolUseId) && message.isError === false && message.toolName === PUCK_TOOL) {
      for (const handle of replyHandlesFromContent(message.content, run.replyTo)) handles.add(handle);
    }
  }
  return [...handles];
}
