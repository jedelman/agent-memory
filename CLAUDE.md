# agent-memory

Semantic memory proxy for the jedelman agent network. Cloudflare Worker + Vectorize.

Built and maintained by Claude (claude@anthropic.com) as shared infrastructure for Scout-Two and Claude agents operating on Bluesky / ATProto.

## What this is

Agents accumulate knowledge across sessions that eventually exceeds context window capacity. This service provides persistent, searchable semantic memory: agents write plain text observations, this service embeds them (Workers AI) and indexes them (Vectorize). At session start, agents query for what's relevant rather than loading everything.

**Principle:** git is canonical (auditable, diffable, rebuildable). Vectorize is the index over it.

## Repo structure

```
src/
  index.ts          ← Worker (deploy this)
  memory-client.ts  ← Copy into agent repos (scout-two, claude-agent)
.claude/
  settings.json     ← Claude Code hooks config
  hooks/
    session-start.sh  ← load secrets, health check, sync, print context
    session-end.sh    ← commit + push session state
wrangler.jsonc      ← Cloudflare config (memory.jason-edelman.org)
USAGE.md            ← Full API reference and integration guide
```

## Infrastructure

| Component | Config |
|-----------|--------|
| Worker URL | `https://memory.jason-edelman.org` |
| Vectorize index | `agent-memory` (768 dims, cosine, `@cf/baai/bge-base-en-v1.5`) |
| Auth | Bearer token via `MEMORY_SECRET` Wrangler secret |

## Deployment (one-time)

Run from this repo root:

```bash
npx wrangler login                    # auth to Cloudflare
npx wrangler vectorize create agent-memory --dimensions=768 --metric=cosine
npx wrangler deploy                   # deploys to memory.jason-edelman.org
openssl rand -hex 32                  # generate secret, copy it
npx wrangler secret put MEMORY_SECRET # paste secret
```

Store secret locally:
```bash
pass insert cloudflare/memory-proxy-secret  # paste same value
pass insert cloudflare/memory-proxy-url     # https://memory.jason-edelman.org
```

## Picking this up in a new session

1. Clone this repo
2. Read `USAGE.md` for full API reference
3. Run `source .claude/hooks/session-start.sh` to load env
4. Health check: `curl https://memory.jason-edelman.org/health`

If the Worker needs changes: edit `src/index.ts`, run `npx wrangler deploy`.
If the Vectorize index needs rebuilding: see "Rebuild index" in USAGE.md.

## Agent repos that use this

- `jedelman/atproto-agent` (Scout-Two) — copy `src/memory-client.ts` → `src/`
- `jedelman/claude-agent` (Claude) — same

Add secrets to each repo's environment:
```bash
MEMORY_PROXY_URL=https://memory.jason-edelman.org
MEMORY_PROXY_SECRET=<from pass>
```

## Key decisions

- **768 dims** — `@cf/baai/bge-base-en-v1.5`, free via Workers AI, good quality for English prose
- **Single index, namespace by agent** — enables cross-agent queries without extra infrastructure
- **No auth on `/health`** — safe to ping from anywhere for liveness checks
- **`/list` uses zero-vector** — approximate; Vectorize is a similarity engine not a DB
- **Metadata stores original text** — agents get text back in query results, no separate lookup needed

## Constraints

- Vectorize metadata values: `string | number | boolean | string[]` — no `null`, no `undefined`
- Upserts are async; ~few seconds before queryable
- `topK` max 50 when returning values/metadata; 100 without
- Free tier: 100k Worker requests/day, 30M queried vector dims/month (well within our usage)
