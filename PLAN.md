# AI Gateway - 3-Tier LiteLLM Proxy

## Overview
Three OpenAI-compatible endpoints via LiteLLM proxy, each with ordered fallback chains.
All endpoints are localhost/docker-network only — NOT exposed to the public web.

## Available Resources

### Ollama Cloud (via local Ollama at localhost:11434)
| Model | Alias | Tier |
|-------|-------|------|
| glm-5.1:cloud | Opus | Smart |
| gemma4:31b-cloud | OpusFallbackCloud | Smart/Normal |

### Ollama Local (localhost:11434)
| Model | Size | Tier |
|-------|------|------|
| gemma4:31b | 31.3B Q4_K_M | Smart/Normal |
| gemma4:26b | 25.8B Q4_K_M | Normal |
| gemma4:e2b | 5.1B Q4_K_M | Fast |
| hermes3 | 8B Q4_0 | Fast |
| llama3.2 | 3.2B Q4_K_M | Fast |

### OpenRouter Free (via proxy at localhost:4001)
| Model | Size/Type | Tier |
|-------|-----------|------|
| qwen/qwen3-coder:free | 480B MoE (35B active) | Smart |
| openai/gpt-oss-120b:free | 117B MoE (5.1B active) | Smart |
| qwen/qwen3-next-80b-a3b-instruct:free | 80B MoE (3B active) | Normal |
| google/gemma-4-31b-it:free | 31B dense | Normal |
| google/gemma-4-26b-a4b-it:free | 25B MoE (4B active) | Normal/Fast |
| openai/gpt-oss-20b:free | 21B MoE (3.6B active) | Fast |

## Fallback Chains

### Smart Tier (`model: smart`)
Priority order (try each, fall through on any failure):
1. `ollama/glm-5.1:cloud` — Best model, cloud-hosted GLM
2. `openrouter/qwen/qwen3-coder:free` — 480B MoE coding beast
3. `openrouter/openai/gpt-oss-120b:free` — 120B reasoning
4. `ollama/gemma4:31b-cloud` — Cloud Gemma fallback
5. `ollama/gemma4:31b` — Local 31B fallback
6. `ollama/gemma4:26b` — Local 26B last resort

### Normal Tier (`model: normal`)
Priority order:
1. `ollama/gemma4:31b-cloud` — Cloud 31B
2. `openrouter/qwen/qwen3-next-80b-a3b-instruct:free` — 80B MoE
3. `openrouter/google/gemma-4-31b-it:free` — Free Gemma 31B
4. `ollama/gemma4:31b` — Local 31B
5. `ollama/gemma4:26b` — Local 26B
6. `openrouter/google/gemma-4-26b-a4b-it:free` — Free 26B MoE
7. `ollama/gemma4:e2b` — Local 5B fallback

### Fast Tier (`model: fast`)
Priority order:
1. `openrouter/google/gemma-4-26b-a4b-it:free` — Fast 4B active MoE
2. `openrouter/openai/gpt-oss-20b:free` — Fast 3.6B active MoE
3. `ollama/gemma4:e2b` — Local 5B
4. `ollama/hermes3` — Local 8B
5. `ollama/llama3.2` — Local 3B

## Architecture

```
Client → LiteLLM Proxy (localhost:4000) → Router
                                           ├─ Ollama (localhost:11434)
                                           └─ OpenRouter Proxy (localhost:4001)
```

- LiteLLM runs as a Docker container
- Bound to 127.0.0.1:4000 only
- Connected to docker `internal` network for container-to-container access
- Uses LiteLLM's built-in router with `fallbacks` for ordered model failover
- OpenAI-compatible API at /v1/chat/completions

## Endpoints

```bash
# Smart
curl http://localhost:4000/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "..."}]}'

# Normal
curl http://localhost:4000/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"model": "normal", "messages": [{"role": "user", "content": "..."}]}'

# Fast
curl http://localhost:4000/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"model": "fast", "messages": [{"role": "user", "content": "..."}]}'
```
