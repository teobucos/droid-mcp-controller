import { DroidClient, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { z } from 'zod';
import { ToolError } from './errors.mjs';

const catalogSchema = z.array(z.object({
  id: z.string().min(1), displayName: z.string().min(1), disabled: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  modelProvider: z.string().optional(),
  supportedReasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  noImageSupport: z.boolean().optional(), supportsPDFs: z.boolean().optional(),
}));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export class ModelCatalog {
  constructor(config) {
    this.config = config;
    this.cache = null;
    this.pending = null;
    this.stopping = false;
  }

  async get() {
    if (this.stopping) throw new ToolError('shutting_down', 'Controller is shutting down');
    if (this.cache && performance.now() - this.cache.at < this.config.modelCacheTtlMs) return this.cache.value;
    // All HTTP MCP instances share this cache and one in-flight refresh.
    this.pending ??= this.discover().then((value) => {
      this.cache = { value, at: performance.now() };
      return value;
    }).catch((error) => {
      console.error('Factory model discovery failed:', error);
      throw new ToolError('model_discovery_failed', 'Unable to retrieve the current Factory model catalog');
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async discover() {
    const transport = new ProcessTransport({
      droidExecPath: this.config.droidPath, cwd: this.config.stateDirectory,
      env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    });
    let catalog;
    let initializeId;
    const send = transport.send.bind(transport);
    transport.send = (line) => {
      const request = JSON.parse(line);
      if (request.type === 'request' && request.method === 'droid.initialize_session') initializeId = request.id;
      return send(line);
    };
    const onMessage = transport.onMessage.bind(transport);
    transport.onMessage = (handler) => onMessage((line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { handler(line); return; }
      if (initializeId !== undefined && message.type === 'response' && message.id === initializeId && !message.error && message.result?.sessionId) {
        // SDK 0.9.1 strips disabled/deprecated and requires display metadata.
        // Preserve ONLY the correlated initialization catalog. deprecated and
        // supportsPDFs were observed on authenticated CLI 0.236.0, not guessed.
        initializeId = undefined;
        const { availableModels, ...result } = message.result;
        catalog = availableModels;
        handler(JSON.stringify({ ...message, result }));
      } else handler(line);
    });
    const client = new DroidClient({ transport, sessionInitTimeout: Math.min(this.config.runTimeoutMs, 30000), requestTimeout: this.config.cancelGraceMs });
    client.setPermissionHandler(() => ToolConfirmationOutcome.Cancel);
    client.setAskUserHandler(() => ({ cancelled: true, answers: [] }));
    try {
      await transport.connect();
      await client.initializeSession({ machineId: 'default', cwd: this.config.stateDirectory, autonomyLevel: 'off', interactionMode: 'spec', disableBuiltinSkills: true });
      const models = catalogSchema.parse(catalog).filter((model) => model.disabled !== true && model.deprecated !== true).map((model) => ({
        id: model.id, displayName: model.displayName,
        ...(model.deprecated !== undefined ? { deprecated: model.deprecated } : {}),
        ...(model.modelProvider !== undefined ? { provider: model.modelProvider } : {}),
        ...(model.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
        ...(model.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        ...(model.noImageSupport !== undefined ? { supportsImages: !model.noImageSupport } : {}),
        ...(model.supportsPDFs !== undefined ? { supportsPdfs: model.supportsPDFs } : {}),
      })).sort((a, b) => compare(a.displayName, b.displayName) || compare(a.id, b.id));
      return { fetchedAt: new Date().toISOString(), models };
    } finally {
      try { if (client.sessionId) await client.closeSession({ reason: 'other' }); }
      finally { await client.close(); }
    }
  }

  async close() {
    this.stopping = true;
    await this.pending?.catch(() => {});
  }
}
