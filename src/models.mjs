import { DroidClient, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { z } from 'zod';

const catalogSchema = z.array(z.object({
  id: z.string().min(1), displayName: z.string().min(1), disabled: z.boolean().optional(),
  provider: z.string().optional(), modelProvider: z.string().optional(),
  supportedReasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  supportsImages: z.boolean().optional(), noImageSupport: z.boolean().optional(), supportsPdfs: z.boolean().optional(),
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
    if (this.stopping) throw new Error('Controller is shutting down');
    if (this.cache && performance.now() - this.cache.at < this.config.modelCacheTtlMs) return this.cache.value;
    // All HTTP MCP instances share this cache and one in-flight refresh.
    this.pending ??= this.discover().then((value) => {
      this.cache = { value, at: performance.now() };
      return value;
    }).catch((error) => {
      console.error('Factory model discovery failed:', error);
      throw Object.assign(new Error('Unable to retrieve the current Factory model catalog'), { code: 'model_discovery_failed' });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async discover() {
    const transport = new ProcessTransport({
      droidExecPath: this.config.droidPath, cwd: this.config.stateDirectory,
      env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    });
    let catalog;
    const onMessage = transport.onMessage.bind(transport);
    transport.onMessage = (handler) => onMessage((line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { handler(line); return; }
      if (message.type === 'response' && message.result?.sessionId) {
        // SDK 0.9.1's availableModels schema strips disabled fields and requires
        // optional display metadata. Preserve the raw live catalog and validate
        // it ourselves; let DroidClient validate the rest of initialization.
        const { availableModels, available_models, ...result } = message.result;
        catalog = availableModels ?? available_models;
        handler(JSON.stringify({ ...message, result }));
      } else handler(line);
    });
    const client = new DroidClient({ transport, sessionInitTimeout: Math.min(this.config.runTimeoutMs, 30000), requestTimeout: this.config.cancelGraceMs });
    client.setPermissionHandler(() => ToolConfirmationOutcome.Cancel);
    client.setAskUserHandler(() => ({ cancelled: true, answers: [] }));
    try {
      await transport.connect();
      await client.initializeSession({ machineId: 'default', cwd: this.config.stateDirectory, autonomyLevel: 'off', interactionMode: 'spec', disableBuiltinSkills: true });
      const models = catalogSchema.parse(catalog).filter((model) => model.disabled !== true).map((model) => ({
        id: model.id, displayName: model.displayName,
        ...((model.provider ?? model.modelProvider) !== undefined ? { provider: model.provider ?? model.modelProvider } : {}),
        ...(model.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
        ...(model.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : model.noImageSupport !== undefined ? { supportsImages: !model.noImageSupport } : {}),
        ...(model.supportsPdfs !== undefined ? { supportsPdfs: model.supportsPdfs } : {}),
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
