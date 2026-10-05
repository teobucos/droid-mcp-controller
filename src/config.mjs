import { readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';

export const autonomy = z.enum(['off', 'low', 'medium', 'high']);
export const reasoning = z.enum(['off', 'none', 'dynamic', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const conversationId = z.string().regex(/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const absolute = z.string().refine(isAbsolute, 'Use an absolute path (expand ~ yourself)');
const schema = z.object({
  approvedDirectories: z.array(absolute).min(1),
  stateDirectory: absolute,
  droidPath: absolute,
  transport: z.enum(['stdio', 'http']).default('stdio'),
  port: z.number().int().min(0).max(65535).default(8787),
  tokenFile: absolute.optional(),
  publicUrl: z.string().url().optional(),
  maxAutonomy: autonomy.default('high'),
  defaultAutonomy: autonomy.default('high'),
  reasoningEffort: reasoning.optional(),
  maxConcurrentRuns: z.number().int().min(1).max(16).default(4),
  runTimeoutMs: z.number().int().min(1000).max(86400000).default(3600000),
  cancelGraceMs: z.number().int().min(100).max(30000).default(5000),
  modelCacheTtlMs: z.number().int().min(5000).max(600000).default(60000),
  puck: z.object({
    conversationId,
    url: z.string().url().default('https://ampcode.com/mcp?profile=external-agent').refine((value) => {
      const url = new URL(value);
      return url.origin === 'https://ampcode.com' && !url.username && !url.password && url.pathname === '/mcp' && !url.hash
        && url.searchParams.get('profile') === 'external-agent'
        && [...url.searchParams.keys()].every((key) => ['profile', 'threadID'].includes(key));
    }, 'Use the credential-free Amp external-agent MCP endpoint'),
  }).strict().optional(),
}).strict().refine((config) => autonomy.options.indexOf(config.defaultAutonomy) <= autonomy.options.indexOf(config.maxAutonomy), 'defaultAutonomy cannot exceed maxAutonomy');

export function loadConfig(path) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Linux or macOS required for process-group cleanup');
  const config = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  config.approvedDirectories = config.approvedDirectories.map((p) => {
    const dir = realpathSync(p);
    if (!statSync(dir).isDirectory()) throw new Error('Approved paths must be directories');
    return dir;
  });
  accessSync(config.droidPath, constants.X_OK);
  if (config.transport === 'http') {
    if (!config.tokenFile) throw new Error('HTTP requires tokenFile; unauthenticated listeners are forbidden');
    if ((statSync(config.tokenFile).mode & 0o077) !== 0) throw new Error('tokenFile must be private (chmod 600)');
    config.token = readFileSync(config.tokenFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(config.token)) throw new Error('tokenFile needs at least 32 random URL-safe characters');
    if (config.publicUrl) {
      const url = new URL(config.publicUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash) {
        throw new Error('publicUrl must be a credential-free HTTPS URL ending in /mcp');
      }
    }
  }
  return config;
}

export function approvedWorkspace(config, path) {
  if (!isAbsolute(path)) throw new Error('Workspace requires an absolute approved directory');
  const cwd = realpathSync(path);
  if (!statSync(cwd).isDirectory() || !config.approvedDirectories.some((root) => {
    const part = relative(root, cwd);
    return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
  })) throw new Error('Workspace is outside approved directories');
  return cwd;
}

// Inputs must already be existing realpath-resolved directories.
export function pathsOverlap(a, b) {
  const contains = (root, path) => {
    const part = relative(root, path);
    return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
  };
  return contains(a, b) || contains(b, a);
}
