import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const checks: Record<string, string> = {};

  // Check env vars
  checks.OPENAI_API_KEY = process.env.OPENAI_API_KEY ? 'set' : 'missing';
  checks.EDINETDB_API_KEY = process.env.EDINETDB_API_KEY ? 'set' : 'missing';
  checks.DEXTER_MODEL = process.env.DEXTER_MODEL ?? 'not set (default gpt-5.4)';

  // Check imports
  try {
    await import('../src/providers.js');
    checks.providers = 'ok';
  } catch (e: any) {
    checks.providers = `error: ${e.message}`;
  }

  try {
    await import('../src/agent/types.js');
    checks.agent_types = 'ok';
  } catch (e: any) {
    checks.agent_types = `error: ${e.message}`;
  }

  try {
    await import('../src/gateway/agent-runner.js');
    checks.agent_runner = 'ok';
  } catch (e: any) {
    checks.agent_runner = `error: ${e.message?.slice(0, 200)}`;
  }

  res.json(checks);
}
