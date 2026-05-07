# AI Gateway - 3-Tier LiteLLM Proxy

## Overview
Three OpenAI-compatible endpoints via LiteLLM proxy, each with ordered fallback (waterfall) chains.
The LiteLLM API is localhost/docker-network only. The config UI is behind Authelia SSO.

## Quick Start

### Hit the gateway

```bash
# Base URL
export GATEWAY_URL="http://localhost:4000/v1"
export GATEWAY_KEY="sk-litellm-gateway-a8f3c9d2e1b0"

# Smart tier (best reasoning/coding models)
curl $GATEWAY_URL/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "Hello!"}]}'

# Normal tier (balanced)
curl $GATEWAY_URL/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "normal", "messages": [{"role": "user", "content": "Hello!"}]}'

# Fast tier (speed-first)
curl $GATEWAY_URL/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "fast", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Use with any OpenAI-compatible client

- **Base URL:** `http://localhost:4000/v1`
- **API Key:** `sk-litellm-gateway-a8f3c9d2e1b0`
- **Model:** `smart`, `normal`, or `fast`

### Config UI

- **Local:** http://localhost:4002
- **Public (SSO):** https://aigateway.aaroncollins.info (requires Authelia login)

## Available Resources

### Ollama Cloud (via local Ollama at localhost:11434)
| Model | Alias | Tier |
|-------|-------|------|
| glm-5.1:cloud | Opus | Smart |
| gemma4:31b-cloud | OpusFallbackCloud | Smart |

### Ollama Local (localhost:11434, CPU — ~10 min response)
| Model | Size | Tier |
|-------|------|------|
| gemma4:31b | 31.3B Q4_K_M | Smart/Normal |
| gemma4:26b | 25.8B Q4_K_M | Smart/Normal |
| gemma4:e2b | 5.1B Q4_K_M | Normal/Fast |
| hermes3 | 8B Q4_0 | Fast |
| llama3.2 | 3.2B Q4_K_M | Fast |

### OpenRouter Free (direct API, $0 cost)
| Model | Size/Type | Tier |
|-------|-----------|------|
| qwen/qwen3-coder:free | 480B MoE (35B active) | Smart |
| openai/gpt-oss-120b:free | 117B MoE (5.1B active) | Smart |
| qwen/qwen3-next-80b-a3b-instruct:free | 80B MoE (3B active) | Normal |
| google/gemma-4-31b-it:free | 31B dense | Smart/Normal |
| google/gemma-4-26b-a4b-it:free | 25B MoE (4B active) | Normal/Fast |
| openai/gpt-oss-20b:free | 21B MoE (3.6B active) | Fast |

## Waterfall Chains

Each tier tries models in order. If a model fails (timeout, rate limit, error), it instantly falls to the next one. Cloud/API models timeout at 30s, local models at 600s (CPU).

### Smart Tier (`model: smart`)
| # | Model | Provider | Timeout |
|---|-------|----------|---------|
| 1 | glm-5.1:cloud | Ollama Cloud | 30s |
| 2 | qwen/qwen3-coder:free | OpenRouter | 30s |
| 3 | openai/gpt-oss-120b:free | OpenRouter | 30s |
| 4 | gemma4:31b-cloud | Ollama Cloud | 30s |
| 5 | google/gemma-4-31b-it:free | OpenRouter | 30s |
| 6 | gemma4:31b | Ollama Local | 600s |
| 7 | gemma4:26b | Ollama Local | 600s |

### Normal Tier (`model: normal`)
| # | Model | Provider | Timeout |
|---|-------|----------|---------|
| 1 | qwen/qwen3-next-80b-a3b-instruct:free | OpenRouter | 30s |
| 2 | google/gemma-4-31b-it:free | OpenRouter | 30s |
| 3 | google/gemma-4-26b-a4b-it:free | OpenRouter | 30s |
| 4 | gemma4:31b-cloud | Ollama Cloud | 30s |
| 5 | gemma4:31b | Ollama Local | 600s |
| 6 | gemma4:26b | Ollama Local | 600s |
| 7 | gemma4:e2b | Ollama Local | 600s |

### Fast Tier (`model: fast`)
| # | Model | Provider | Timeout |
|---|-------|----------|---------|
| 1 | google/gemma-4-26b-a4b-it:free | OpenRouter | 20s |
| 2 | openai/gpt-oss-20b:free | OpenRouter | 20s |
| 3 | gemma4:e2b | Ollama Local | 600s |
| 4 | hermes3 | Ollama Local | 600s |
| 5 | llama3.2 | Ollama Local | 600s |

## Architecture

```
Client (curl, OpenClaw, any OpenAI client)
    │
    ▼
LiteLLM Proxy (127.0.0.1:4000)
    │  model: "smart" | "normal" | "fast"
    │
    ▼
Router (waterfall fallback)
    ├─ Ollama Cloud (localhost:11434 → ollama.com)
    ├─ OpenRouter Free (openrouter.ai/api/v1)
    └─ Ollama Local (localhost:11434, CPU)

Config UI (127.0.0.1:4002 / aigateway.aaroncollins.info)
    │  Reads/writes litellm_config.yaml
    │  Can restart LiteLLM container
    └─ Protected by Authelia SSO
```

## Services

| Service | Port | Access |
|---------|------|--------|
| LiteLLM Proxy | 127.0.0.1:4000 | localhost only |
| Config UI | 127.0.0.1:4002 | localhost + SSO at aigateway.aaroncollins.info |

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | LiteLLM + UI containers |
| `litellm_config.yaml` | Gateway config (has API keys, gitignored) |
| `litellm_config.example.yaml` | Template config (safe to commit) |
| `ui/server.js` | Config UI backend |
| `ui/public/index.html` | Config UI frontend |
| `ui/Dockerfile` | UI container build |

## GitHub

Repository: https://github.com/aaron777collins/aigateway

## DNS Required

Add an A record: `aigateway.aaroncollins.info` → `65.108.1.247`
