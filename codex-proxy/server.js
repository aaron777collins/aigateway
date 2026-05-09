'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '4020', 10);
const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_API_BASE = 'https://chatgpt.com/backend-api';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const JWT_CLAIM = 'https://api.openai.com/auth';

const BACKOFF_MS = 20 * 60 * 1000;
const TOKEN_TTL_MS = 50 * 60 * 1000; // refresh 10 min before the 1-hour expiry

// ---- State ----

let backoffUntil = 0;
let cachedAccess = null;
let tokenExpiresAt = 0;

// ---- Token management ----

function readAuth() {
  return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
}

function writeAuth(auth) {
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, AUTH_PATH);
}

function decodeJwtPayload(token) {
  const seg = token.split('.')[1];
  return JSON.parse(Buffer.from(seg, 'base64url').toString());
}

function extractAccountId(token) {
  const payload = decodeJwtPayload(token);
  const id = payload?.[JWT_CLAIM]?.chatgpt_account_id;
  if (!id) throw new Error('No chatgpt_account_id in JWT');
  return id;
}

async function refreshTokens(rt) {
  console.log('[token] refreshing...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Token refresh response missing fields');
  }
  console.log('[token] refreshed OK');
  return data;
}

async function getAccessToken() {
  if (cachedAccess && Date.now() < tokenExpiresAt) {
    return cachedAccess;
  }

  const auth = readAuth();
  const tokens = auth.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error('No tokens in auth.json — run codex cli to log in');
  }

  const lastRefresh = auth.last_refresh ? new Date(auth.last_refresh).getTime() : 0;
  const needsRefresh = !lastRefresh || (Date.now() - lastRefresh > TOKEN_TTL_MS);

  if (!needsRefresh) {
    cachedAccess = tokens.access_token;
    tokenExpiresAt = lastRefresh + TOKEN_TTL_MS;
    return cachedAccess;
  }

  const fresh = await refreshTokens(tokens.refresh_token);
  auth.tokens.access_token = fresh.access_token;
  auth.tokens.refresh_token = fresh.refresh_token;
  auth.last_refresh = new Date().toISOString();
  writeAuth(auth);

  cachedAccess = fresh.access_token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedAccess;
}

// ---- Format translation ----

function chatToCodex(body) {
  let instructions = '';
  const input = [];

  for (const msg of body.messages || []) {
    if (msg.role === 'system') {
      instructions += (instructions ? '\n' : '') + (msg.content || '');
    } else if (msg.role === 'user') {
      const content = typeof msg.content === 'string'
        ? [{ type: 'input_text', text: msg.content }]
        : msg.content;
      input.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string'
        ? [{ type: 'output_text', text: msg.content }]
        : msg.content;
      input.push({ role: 'assistant', content });
    }
  }

  const codexBody = {
    model: body.model || 'gpt-4o',
    store: false,
    stream: true,
    instructions: instructions || undefined,
    input,
    text: { verbosity: 'medium' },
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };

  if (body.temperature !== undefined) codexBody.temperature = body.temperature;
  if (body.max_tokens !== undefined) codexBody.max_output_tokens = body.max_tokens;

  return codexBody;
}

// ---- SSE parser (buffers full response) ----

function parseSSEEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    let eventType = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data && data !== '[DONE]') {
      try {
        events.push({ type: eventType, data: JSON.parse(data) });
      } catch { /* skip malformed */ }
    }
  }
  return events;
}

function extractText(events) {
  let text = '';
  let model = '';
  let stopReason = 'stop';

  for (const ev of events) {
    if (ev.data?.type === 'response.output_text.delta' || ev.type === 'response.output_text.delta') {
      text += ev.data.delta || '';
    }
    if (ev.type === 'response.completed' || ev.type === 'response.done') {
      model = ev.data?.response?.model || model;
      const status = ev.data?.response?.status;
      if (status === 'incomplete') stopReason = 'length';
      else if (status === 'failed' || status === 'cancelled') stopReason = 'stop';
    }
    if (ev.type === 'response.created') {
      model = ev.data?.response?.model || model;
    }
    if (ev.type === 'response.failed') {
      const msg = ev.data?.response?.error?.message || 'Codex response failed';
      throw new Error(msg);
    }
  }

  return { text, model, stopReason };
}

// ---- Request handler ----

async function handleChat(req, res) {
  // Backoff check
  if (Date.now() < backoffUntil) {
    const mins = Math.ceil((backoffUntil - Date.now()) / 60000);
    console.log(`[backoff] rejecting request, ${mins} min remaining`);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Codex proxy in backoff for ~${mins} more min`, type: 'rate_limit' },
    }));
    return;
  }

  // Read body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    return;
  }

  // Get token
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error('[token]', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Auth error: ' + e.message } }));
    return;
  }

  let accountId;
  try {
    accountId = extractAccountId(accessToken);
  } catch (e) {
    console.error('[jwt]', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }

  const codexBody = chatToCodex(body);
  const codexUrl = `${CODEX_API_BASE}/codex/responses`;

  console.log(`[req] model=${codexBody.model} messages=${(body.messages || []).length}`);

  // Single attempt — no retries
  let codexRes;
  try {
    codexRes = await fetch(codexUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
        'accept': 'text/event-stream',
        'User-Agent': 'aigateway-codex-proxy/1.0',
      },
      body: JSON.stringify(codexBody),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    console.error('[fetch]', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream error: ' + e.message } }));
    return;
  }

  if (!codexRes.ok) {
    const errText = await codexRes.text().catch(() => '');
    console.error(`[codex] ${codexRes.status}: ${errText.slice(0, 200)}`);

    if (codexRes.status === 429 || codexRes.status >= 500) {
      backoffUntil = Date.now() + BACKOFF_MS;
      console.log(`[backoff] ACTIVATED — no requests until ${new Date(backoffUntil).toISOString()}`);
    }

    // If token was rejected, clear cache so next request re-reads
    if (codexRes.status === 401 || codexRes.status === 403) {
      cachedAccess = null;
      tokenExpiresAt = 0;
    }

    res.writeHead(codexRes.status >= 500 ? 503 : codexRes.status, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ error: { message: errText || `Codex ${codexRes.status}` } }));
    return;
  }

  // Buffer the full SSE response
  let sseText;
  try {
    sseText = await codexRes.text();
  } catch (e) {
    console.error('[stream]', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Stream read error: ' + e.message } }));
    return;
  }

  const events = parseSSEEvents(sseText);
  let result;
  try {
    result = extractText(events);
  } catch (e) {
    console.error('[parse]', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }

  console.log(`[res] model=${result.model} chars=${result.text.length} stop=${result.stopReason}`);

  // Return standard chat completion format
  const response = {
    id: `chatcmpl-codex-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model || codexBody.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.text },
      finish_reason: result.stopReason,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
}

// ---- Server ----

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const inBackoff = Date.now() < backoffUntil;
    res.writeHead(inBackoff ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: inBackoff ? 'backoff' : 'ok',
      backoff_until: inBackoff ? new Date(backoffUntil).toISOString() : null,
      backoff_remaining_min: inBackoff ? Math.ceil((backoffUntil - Date.now()) / 60000) : 0,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-4o', object: 'model', owned_by: 'codex-proxy' }],
    }));
    return;
  }

  if (req.method === 'POST' && /\/v1\/chat\/completions/.test(req.url)) {
    handleChat(req, res).catch((e) => {
      console.error('[fatal]', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: 'Internal proxy error' } }));
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex proxy listening on 127.0.0.1:${PORT}`);
  console.log(`  Auth: ${AUTH_PATH}`);
  console.log(`  Backoff: ${BACKOFF_MS / 60000} min on rate-limit/5xx`);
  console.log(`  Retries: NONE (single attempt per request)`);
});
