'use strict';

const http = require('http');
const fs = require('fs');
const yaml = require('js-yaml');

const LITELLM_HOST = process.env.LITELLM_HOST || 'litellm';
const LITELLM_PORT = parseInt(process.env.LITELLM_PORT || '4000', 10);
const CONFIG_PATH = process.env.CONFIG_PATH || '/config/litellm_config.yaml';
const PORT = parseInt(process.env.PORT || '4001', 10);

// model_name alias → actual litellm model identifier
let modelMap = {};

function reloadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = yaml.load(raw);
    modelMap = {};
    for (const entry of cfg.model_list || []) {
      modelMap[entry.model_name] = entry.litellm_params?.model || entry.model_name;
    }
    console.log(`Loaded ${Object.keys(modelMap).length} model mappings`);
  } catch (e) {
    console.error('Config load error:', e.message);
  }
}

reloadConfig();
fs.watchFile(CONFIG_PATH, { interval: 5000 }, reloadConfig);

function cleanModel(m) {
  return m.replace(/^(ollama|openrouter|groq)\//, '');
}

function resolveModel(responseModel) {
  if (modelMap[responseModel]) return modelMap[responseModel];
  return responseModel;
}

function getChainName(requestModel) {
  return requestModel.replace(/-\d+$/, '');
}

function makePrefix(chain, actualModel) {
  return `[${chain}/${cleanModel(actualModel)}]`;
}

// ---- Streaming handler ----

function handleStreaming(chain, proxyRes, clientRes) {
  const headers = { ...proxyRes.headers };
  delete headers['content-length'];
  clientRes.writeHead(proxyRes.statusCode, headers);

  proxyRes.setEncoding('utf8');
  let prefixSent = false;
  let buf = '';

  proxyRes.on('data', (chunk) => {
    if (prefixSent) {
      clientRes.write(chunk);
      return;
    }

    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);

      if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (delta && delta.content != null) {
            const actual = resolveModel(data.model || chain);
            delta.content = makePrefix(chain, actual) + '\n' + delta.content;
            clientRes.write('data: ' + JSON.stringify(data) + '\n');
            prefixSent = true;
            if (buf) { clientRes.write(buf); buf = ''; }
            return;
          }
        } catch (e) { /* parse error — pass through */ }
      }
      clientRes.write(line + '\n');
    }
  });

  proxyRes.on('end', () => {
    if (buf) clientRes.write(buf);
    clientRes.end();
  });
}

// ---- Non-streaming handler ----

function handleNonStreaming(chain, proxyRes, clientRes) {
  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    let body = Buffer.concat(chunks);
    try {
      const data = JSON.parse(body.toString());
      const actual = resolveModel(data.model || chain);
      const prefix = makePrefix(chain, actual);
      const msg = data.choices?.[0]?.message;
      if (msg && msg.content != null) {
        msg.content = prefix + '\n' + msg.content;
      }
      body = Buffer.from(JSON.stringify(data));
    } catch (e) { /* can't parse — pass through unchanged */ }

    const headers = { ...proxyRes.headers };
    headers['content-length'] = body.length;
    clientRes.writeHead(proxyRes.statusCode, headers);
    clientRes.end(body);
  });
}

// ---- Main proxy server ----

const server = http.createServer((req, res) => {
  const bodyChunks = [];
  req.on('data', (c) => bodyChunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);

    const isChatPath = /\/chat\/completions/.test(req.url);
    let chain = null;
    let streaming = false;

    if (isChatPath && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        chain = parsed.model || null;
        streaming = parsed.stream === true;
      } catch (e) { /* not JSON — pass through */ }
    }

    const fwdHeaders = { ...req.headers, host: `${LITELLM_HOST}:${LITELLM_PORT}` };
    if (isChatPath && chain) fwdHeaders['accept-encoding'] = 'identity';

    const proxyReq = http.request(
      {
        hostname: LITELLM_HOST,
        port: LITELLM_PORT,
        path: req.url,
        method: req.method,
        headers: fwdHeaders,
      },
      (proxyRes) => {
        if (!isChatPath || !chain) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }

        const chainName = getChainName(chain);

        if (streaming) {
          handleStreaming(chainName, proxyRes, res);
        } else {
          handleNonStreaming(chainName, proxyRes, res);
        }
      },
    );

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Gateway proxy error: ' + err.message } }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Gateway Proxy listening on port ${PORT}`);
  console.log(`  Forwarding to ${LITELLM_HOST}:${LITELLM_PORT}`);
  console.log(`  Config: ${CONFIG_PATH}`);
});
