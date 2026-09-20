import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { validate } from '../middleware/validate';
import { decryptConfigSecret } from '../lib/secureConfig';
import { badRequest, serviceUnavailable } from '../lib/errors';
import { authorize } from '../middleware/rbac';

const router = Router();
const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) })).min(1).max(20),
});

const testSchema = z.object({
  provider: z.string().max(100).optional(),
  endpoint: z.string().url().max(500).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(1000).optional(),
});

router.post('/test', authorize('admin.config'), validate({ body: testSchema }), asyncHandler(async (req, res) => {
  const rows = await prisma.systemConfig.findMany({ where: { key: { in: ['ai.apiKey', 'ai.endpoint', 'ai.model'] } } });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const body = req.body as z.infer<typeof testSchema>;
  const apiKey = body.apiKey || decryptConfigSecret(stored.get('ai.apiKey'));
  if (!apiKey) throw serviceUnavailable('Add an AI API key before testing the assistant');
  const endpoint = body.endpoint || (typeof stored.get('ai.endpoint') === 'string' && stored.get('ai.endpoint') ? String(stored.get('ai.endpoint')) : 'https://api.openai.com/v1/chat/completions');
  const model = body.model || (typeof stored.get('ai.model') === 'string' && stored.get('ai.model') ? String(stored.get('ai.model')) : 'gpt-4o-mini');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 5 }),
  });
  if (!response.ok) return res.status(502).json({ error: { message: 'The AI provider rejected the test request. Check the endpoint, model and API key.' } });
  res.json({ ok: true, message: 'AI connection verified.' });
}));

router.post('/chat', validate({ body: bodySchema }), asyncHandler(async (req, res) => {
  const configRows = await prisma.systemConfig.findMany({ where: { key: { in: ['ai.apiKey', 'ai.endpoint', 'ai.model'] } } });
  const config = new Map(configRows.map((row) => [row.key, row.value]));
  const apiKey = decryptConfigSecret(config.get('ai.apiKey'));
  if (!apiKey) throw serviceUnavailable('AI assistant is not configured for this organization');
  const endpoint = typeof config.get('ai.endpoint') === 'string' && config.get('ai.endpoint')
    ? String(config.get('ai.endpoint'))
    : 'https://api.openai.com/v1/chat/completions';
  const model = typeof config.get('ai.model') === 'string' && config.get('ai.model') ? String(config.get('ai.model')) : 'gpt-4o-mini';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: 'You are Buildora Assistant. Answer concisely using only information the user provides or general real-estate operations knowledge.' }, ...req.body.messages] }),
  });
  if (!response.ok) throw serviceUnavailable('The AI provider could not complete the request');
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw badRequest('The AI provider returned an empty response');
  res.json({ message: content });
}));

export default router;
