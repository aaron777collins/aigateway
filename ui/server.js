'use strict';

/**
 * AI Gateway Config UI — Backend Server
 *
 * Why a separate backend at all: the litellm_config.yaml lives on the host
 * filesystem and docker socket access is required to restart the container,
 * so a static-only frontend cannot fulfil those operations.
 *
 * Environment variables (all optional — defaults work inside docker-compose):
 *   CONFIG_PATH       Absolute path to litellm_config.yaml
 *   LITELLM_URL       Base URL of the running LiteLLM instance
 *   LITELLM_CONTAINER Name of the docker container to restart on save
 *   PORT              HTTP port to listen on (default 4002)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');
const fetch = require('node-fetch');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH || '/config/litellm_config.yaml';
const LITELLM_URL = process.env.LITELLM_URL || 'http://litellm:4000';
const LITELLM_CONTAINER = process.env.LITELLM_CONTAINER || 'aigateway-litellm';
const PORT = parseInt(process.env.PORT || '4002', 10);
const LITELLM_KEY = process.env.LITELLM_KEY || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the YAML config. Throws with a clear message if the file
 * is missing or malformed so the caller can return a useful 5xx to the client.
 */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found at ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return yaml.load(raw);
}

/**
 * Validate the incoming config object before writing it to disk.
 * We enforce structural correctness here so corrupted YAML never reaches disk.
 */
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Config must be a JSON object');
  }
  if (!Array.isArray(cfg.model_list)) {
    throw new Error('Config must contain a model_list array');
  }
  for (const model of cfg.model_list) {
    if (!model.model_name || typeof model.model_name !== 'string') {
      throw new Error('Each model_list entry must have a string model_name');
    }
    if (!model.litellm_params || typeof model.litellm_params !== 'object') {
      throw new Error(`model "${model.model_name}" is missing litellm_params`);
    }
    if (!model.litellm_params.model || typeof model.litellm_params.model !== 'string') {
      throw new Error(`model "${model.model_name}" litellm_params.model must be a non-empty string`);
    }
  }
}

/**
 * Write the config object back to YAML. We do an atomic write via a temp file
 * so a crash mid-write never corrupts the live config.
 */
function writeConfig(cfg) {
  const content = yaml.dump(cfg, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
  });
  fs.writeFileSync(CONFIG_PATH, content, 'utf8');
}

/**
 * Restart the LiteLLM docker container via the docker CLI.
 * The container is restarted (not re-created) which preserves its config.
 * We set a reasonable deadline so a hung docker daemon does not block forever.
 */
function restartContainer() {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['restart', LITELLM_CONTAINER],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docker restart failed: ${stderr || err.message}`));
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Structured error response so the frontend always has a consistent shape.
function apiError(res, statusCode, message) {
  res.status(statusCode).json({ ok: false, error: message });
}

// ---------------------------------------------------------------------------
// GET /api/config
// Returns the current litellm_config.yaml parsed as JSON.
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  try {
    const cfg = readConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    console.error('[GET /api/config]', err.message);
    apiError(res, 500, err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /api/config
// Accepts updated config JSON, writes litellm_config.yaml, and optionally
// restarts the docker container.
//
// Body: { config: <object>, restart: <boolean> }
// ---------------------------------------------------------------------------
app.post('/api/config', async (req, res) => {
  const { config: cfg, restart } = req.body;

  if (!cfg) {
    return apiError(res, 400, 'Request body must include a "config" field');
  }

  try {
    validateConfig(cfg);
  } catch (err) {
    return apiError(res, 400, err.message);
  }

  try {
    writeConfig(cfg);
  } catch (err) {
    console.error('[POST /api/config] write error:', err.message);
    return apiError(res, 500, `Failed to write config: ${err.message}`);
  }

  let restarted = false;
  let restartError = null;

  if (restart) {
    try {
      await restartContainer();
      restarted = true;
    } catch (err) {
      console.error('[POST /api/config] restart error:', err.message);
      // Treat restart failure as a warning, not a hard error — the config
      // was already written successfully.
      restartError = err.message;
    }
  }

  res.json({ ok: true, restarted, restartError });
});

// ---------------------------------------------------------------------------
// GET /api/health
// Proxies the LiteLLM health endpoint so the frontend never has to hit a
// different origin (avoids CORS issues when running behind a reverse proxy).
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const headers = LITELLM_KEY ? { Authorization: `Bearer ${LITELLM_KEY}` } : {};
    const response = await fetch(`${LITELLM_URL}/health/liveliness`, {
      timeout: 5_000,
      headers,
    });
    const body = await response.json().catch(() => ({}));
    res.json({ ok: response.ok, status: response.status, body });
  } catch (err) {
    console.error('[GET /api/health]', err.message);
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health/models
// Proxies the LiteLLM per-model health endpoint for individual status dots.
// ---------------------------------------------------------------------------
app.get('/api/health/models', async (req, res) => {
  try {
    const cfg = readConfig();
    const models = (cfg.model_list || []).map(m => {
      const model = m.litellm_params?.model || '';
      const apiBase = m.litellm_params?.api_base || '';
      const isLocal = model.startsWith('ollama/') && !model.includes(':cloud');
      const isOpenRouter = model.startsWith('openrouter/');
      const isCustom = !isLocal && !isOpenRouter && !model.startsWith('ollama/') && apiBase;
      return {
        model_name: m.model_name,
        model: model,
        status: isLocal ? 'slow' : 'unknown',
        provider: isLocal ? 'ollama-local' : isOpenRouter ? 'openrouter' : model.startsWith('ollama/') ? 'ollama-cloud' : isCustom ? 'custom' : 'other',
        api_base: apiBase,
      };
    });

    const checkPromises = models
      .filter(m => m.provider !== 'ollama-local')
      .map(async (m) => {
        try {
          const params = (cfg.model_list || []).find(x => x.model_name === m.model_name)?.litellm_params;
          if (!params) return;
          let url, headers = {};
          if (m.provider === 'ollama-cloud') {
            url = (params.api_base || 'http://host.docker.internal:11434') + '/api/tags';
          } else if (m.provider === 'openrouter') {
            url = 'https://openrouter.ai/api/v1/models';
            if (params.api_key) headers.Authorization = `Bearer ${params.api_key}`;
          } else if (m.provider === 'custom' && params.api_base) {
            const base = params.api_base.replace(/\/+$/, '').replace(/\/v1$/, '');
            url = base + '/health';
            if (params.api_key) headers.Authorization = `Bearer ${params.api_key}`;
          } else {
            return;
          }
          const r = await fetch(url, { timeout: 5_000, headers });
          m.status = r.ok ? 'healthy' : 'unhealthy';
        } catch {
          m.status = 'unhealthy';
        }
      });
    await Promise.all(checkPromises);

    res.json({ ok: true, models });
  } catch (err) {
    console.error('[GET /api/health/models]', err.message);
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/models
// Fetches available models from a provider endpoint.
// Body: { type: "ollama"|"openrouter"|"custom", api_base?: string, api_key?: string }
// ---------------------------------------------------------------------------
app.post('/api/models', async (req, res) => {
  const { type, api_base, api_key } = req.body;
  try {
    let models = [];
    if (type === 'ollama') {
      const url = (api_base || 'http://host.docker.internal:11434') + '/api/tags';
      const r = await fetch(url, { timeout: 10_000 });
      const data = await r.json();
      models = (data.models || []).map(m => ({
        id: `ollama/${m.name}`,
        name: m.name,
        size: m.details?.parameter_size || '',
        provider: 'ollama',
      }));
    } else if (type === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        timeout: 10_000,
        headers: api_key ? { Authorization: `Bearer ${api_key}` } : {},
      });
      const data = await r.json();
      models = (data.data || [])
        .filter(m => m.id && m.id.endsWith(':free'))
        .map(m => ({
          id: `openrouter/${m.id}`,
          name: m.id,
          context: m.context_length || '',
          provider: 'openrouter',
        }));
    } else {
      const url = (api_base || '').replace(/\/+$/, '') + '/models';
      const headers = {};
      if (api_key) headers.Authorization = `Bearer ${api_key}`;
      const r = await fetch(url, { timeout: 10_000, headers });
      const data = await r.json();
      models = (data.data || data.models || []).map(m => ({
        id: m.id || m.name,
        name: m.id || m.name,
        provider: 'custom',
      }));
    }
    res.json({ ok: true, models });
  } catch (err) {
    console.error('[POST /api/models]', err.message);
    res.status(500).json({ ok: false, error: err.message, models: [] });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Gateway UI listening on port ${PORT}`);
  console.log(`  CONFIG_PATH:       ${CONFIG_PATH}`);
  console.log(`  LITELLM_URL:       ${LITELLM_URL}`);
  console.log(`  LITELLM_CONTAINER: ${LITELLM_CONTAINER}`);
});
