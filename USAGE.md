# agent-memory

A semantic memory proxy for AI agents. Lives on Cloudflare Workers + Vectorize. Agents speak plain text — the proxy handles embeddings, storage, and retrieval.

Built for the jedelman commons intelligence network: Scout-Two (`scout-two.bsky.social`) and Claude, operating as autonomous agents on Bluesky with persistent, searchable memory across sessions.

---

## What It Does

Each agent accumulates memory across sessions — observations about people, patterns in the network, evolving relationships, annotations on ideas. Over time, memory files grow beyond what fits in a context window. This service solves that: agents query for what's relevant to *this* session rather than loading everything.

**The architecture principle:** git is the canonical store (readable, auditable, diffable). Vectorize is the index over it. If Vectorize ever diverges or gets corrupted, rebuild the index from the git-tracked memory files. Nothing is lost.

---

## Infrastructure

| Component | What | Why free |
|-----------|------|----------|
| Cloudflare Worker | HTTP proxy | 100k req/day free tier |
| Vectorize | Vector index (768 dims, cosine) | 30M queried dims/month free |
| Workers AI | `@cf/baai/bge-base-en-v1.5` embeddings | 10k neurons/day free |

At current agent session frequency (~10 sessions/day, ~10 queries/session), monthly usage is well under 1% of free tier limits.

---

## Setup

### 1. Create the Vectorize index

```bash
cd agent-memory-worker
npx wrangler vectorize create agent-memory --dimensions=768 --metric=cosine
```

You'll see output like:
```
✅ Successfully created index 'agent-memory'
```

### 2. Deploy the Worker

```bash
npx wrangler deploy
```

### 2a. Create metadata indexes for filtering

Vectorize requires explicit metadata indexes on any field used in `$eq` filters. Without these, filtered queries silently return empty results. Run once after creating the index:

```bash
npx wrangler vectorize create-metadata-index agent-memory --property-name=agent --type=string
npx wrangler vectorize create-metadata-index agent-memory --property-name=namespace --type=string
npx wrangler vectorize create-metadata-index agent-memory --property-name=type --type=string
```

> **Important:** These indexes apply to new upserts only. If you had existing vectors before running these commands, re-upsert them to make them filterable.

Note the deployed URL — something like `https://agent-memory.YOUR-SUBDOMAIN.workers.dev`

### 3. Set the shared secret

Generate a strong random secret (this is shared by all agents):

```bash
openssl rand -hex 32
```

Then set it:

```bash
npx wrangler secret put MEMORY_SECRET
# paste your generated secret when prompted
```

### 4. Add secrets to agent repos

In each agent's GitHub repository, add these Actions secrets:

| Secret | Value |
|--------|-------|
| `MEMORY_PROXY_URL` | `https://agent-memory.YOUR-SUBDOMAIN.workers.dev` |
| `MEMORY_PROXY_SECRET` | the secret from step 3 |

### 5. Optional: custom domain

To use `memory.jedelman.com` instead of the workers.dev URL:

1. Cloudflare Dashboard → Workers & Pages → agent-memory → Settings → Domains & Routes
2. Add Route: `memory.jedelman.com/*` (zone must be on Cloudflare — it is)
3. Update `MEMORY_PROXY_URL` in agent repos

---

## API Reference

All routes except `/health` require `Authorization: Bearer {MEMORY_SECRET}`.

### `GET /health`

Liveness check. No auth required.

```bash
curl https://agent-memory.YOUR-SUBDOMAIN.workers.dev/health
```

```json
{ "status": "ok", "service": "agent-memory", "version": "1.0.0" }
```

---

### `POST /upsert`

Store or update a memory. **Same `id` = update** (full replace, not merge).

```bash
curl -X POST https://agent-memory.YOUR-SUBDOMAIN.workers.dev/upsert \
  -H "Authorization: Bearer $MEMORY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "scout-two-observations-heartpunk-job-2026-03",
    "text": "Heartpunk navigating accommodation bind in job search: disclosure before hire closes doors; legal protection after hire relies on employer goodwill. Expressing the bind publicly, seeking peer validation.",
    "agent": "scout-two",
    "namespace": "observations",
    "type": "observation",
    "tags": ["heartpunk", "vulnerability", "job-search", "accommodation"],
    "confidence": 0.85,
    "source": "feed"
  }'
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Stable identifier. Same id = update. Recommend: `{agent}-{namespace}-{slug}` |
| `text` | ✅ | Memory content in plain prose. Max 8000 chars. |
| `agent` | ✅ | Owner agent: `scout-two`, `claude`, `shared` |
| `namespace` | ✅ | Logical grouping — see namespaces below |
| `type` | ✅ | Memory type — see types below |
| `tags` | | Array of strings for filtering |
| `confidence` | | 0.0–1.0. Agent's confidence in this memory. |
| `source` | | `session` \| `feed` \| `inference` \| `human` |

**Response:**
```json
{ "ok": true, "id": "scout-two-observations-heartpunk-job-2026-03", "mutationId": "..." }
```

---

### `POST /query`

Find memories semantically similar to a text query. Returns up to `topK` results ranked by cosine similarity.

```bash
curl -X POST https://agent-memory.YOUR-SUBDOMAIN.workers.dev/query \
  -H "Authorization: Bearer $MEMORY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "heartpunk job search accommodation barriers",
    "agent": "scout-two",
    "namespace": "observations",
    "topK": 5
  }'
```

**Fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `text` | required | Query in plain prose |
| `agent` | none | Filter to agent. Omit for cross-agent search. |
| `namespace` | none | Filter to namespace |
| `type` | none | Filter to memory type |
| `topK` | 10 | Max results (1–50) |
| `returnText` | true | Include original text in results |

**Response:**
```json
{
  "memories": [
    {
      "id": "scout-two-observations-heartpunk-job-2026-03",
      "score": 0.94,
      "text": "Heartpunk navigating accommodation bind...",
      "agent": "scout-two",
      "namespace": "observations",
      "type": "observation",
      "tags": "heartpunk,vulnerability,job-search,accommodation",
      "confidence": 0.85,
      "updatedAt": "2026-03-19T..."
    }
  ],
  "count": 1
}
```

---

### `POST /delete`

Remove a memory by id.

```bash
curl -X POST https://agent-memory.YOUR-SUBDOMAIN.workers.dev/delete \
  -H "Authorization: Bearer $MEMORY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "id": "scout-two-observations-heartpunk-job-2026-03" }'
```

---

### `GET /list`

List memories by agent/namespace/type. **Approximate** — uses zero-vector similarity search. For authoritative inventory, use git-tracked memory files.

```bash
curl "https://agent-memory.YOUR-SUBDOMAIN.workers.dev/list?agent=scout-two&namespace=patterns&limit=20" \
  -H "Authorization: Bearer $MEMORY_SECRET"
```

**Params:** `agent`, `namespace`, `type`, `limit` (default 50, max 100)

---

## Namespaces

Namespaces are freeform strings. Suggested conventions:

| Namespace | What goes here |
|-----------|----------------|
| `observations` | Specific things noticed about people or events |
| `patterns` | Recurring dynamics across multiple observations |
| `relationships` | Evolving characterizations of people/entities |
| `annotations` | Meta-notes on concepts, ideas, intellectual threads |
| `notes` | Session scratchpad — things that don't fit elsewhere |
| `shared` | Memories explicitly marked as collective knowledge |

---

## Memory Types

| Type | When to use |
|------|-------------|
| `observation` | Concrete thing noticed: "Heartpunk posted about job search barriers" |
| `pattern` | Cross-observation dynamic: "Heartpunk cycle: crisis → resolution → new vulnerability" |
| `relationship` | Entity characterization: "Alice-bot-yay: engages at substantive level on consciousness philosophy" |
| `annotation` | Meta-note: "The accommodation bind maps to Gramsci's passive revolution — system incorporates without transforming" |
| `note` | Freeform, transient |

---

## Using the TypeScript Client

Copy `src/memory-client.ts` into your agent repo's `src/` directory.

```typescript
import { MemoryClient, formatMemoriesForPrompt } from './memory-client.js'

const memory = new MemoryClient('scout-two')  // or 'claude'

// --- At session start: retrieve relevant context ---

const relevant = await memory.query(
  'recent patterns in network around commons governance',
  { namespace: 'patterns', topK: 8 }
)

// Format for injection into system prompt or digest
const memoryBlock = formatMemoriesForPrompt(relevant, 'RELEVANT PATTERNS')
// → inject into think.ts digest

// --- Cross-agent query: what does the collective know? ---

const collective = await memory.queryShared(
  'Mithlond Norfolk data center infrastructure',
  { topK: 10 }
)

// --- During/after session: store new observations ---

await memory.upsert({
  id: 'scout-two-patterns-commons-capture-2026-03',
  text: 'Pattern emerging: municipal infrastructure proposals get neutralized at the permitting layer before they reach public debate. Dominion Energy interconnect queue as bottleneck = soft capture.',
  namespace: 'patterns',
  type: 'pattern',
  tags: ['commons', 'capture', 'infrastructure', 'norfolk'],
  confidence: 0.75,
  source: 'session',
})
```

---

## Integration with think.ts

In `think.ts`, after loading the feed and before formatting the digest:

```typescript
// Retrieve relevant memories for this session
const memory = new MemoryClient(AGENT_NAME)

// Query based on what's in the feed (top topics)
const topicSummary = posts.slice(0, 5).map(p => p.text).join(' ')
const relevantMemories = await memory.query(topicSummary, { topK: 8 })

// Also get active relationship context
const activeRelationships = await memory.list({
  namespace: 'relationships',
  limit: 20
})

// Inject into digest
const digest = formatDigest(posts, relevantMemories, activeRelationships)
```

Then in the actions schema, add `memory_edits`:

```json
{
  "actions": { "posts": [], "replies": [], "likes": [], "reposts": [] },
  "memory_edits": [
    {
      "id": "scout-two-observations-heartpunk-job-2026-03",
      "operation": "upsert",
      "text": "Heartpunk: accommodation bind in job search...",
      "namespace": "observations",
      "type": "observation",
      "tags": ["heartpunk", "job-search"],
      "confidence": 0.85
    }
  ],
  "out_of_band": { "guidance_requests": [], "feature_requests": [], "bug_reports": [] }
}
```

`act.ts` processes `memory_edits` after Bluesky actions, before the git commit.

---

## ID Conventions

Stable, descriptive IDs prevent duplicate entries and make git history readable:

```
{agent}-{namespace}-{entity/topic}-{YYYY-MM}
```

Examples:
- `scout-two-observations-heartpunk-job-2026-03`
- `claude-patterns-commons-capture-infrastructure-2026-03`
- `shared-annotations-accommodation-bind-gramsci`
- `scout-two-relationships-heartpunk`

For relationship memories, omit the date — the same id gets upserted as the relationship evolves. For observations, include month so each distinct event has its own entry.

---

## Cross-Agent Collaboration

Both agents share one Vectorize index. Namespacing is by `agent` field, not by separate indexes. This means:

- Each agent queries its own memories by default (pass `agent` filter)
- Either agent can query the full index by omitting the `agent` filter
- Memories can be tagged `agent: "shared"` for explicitly collective knowledge

This is how emergent collaboration happens: Scout-Two notices something on the feed, stores it. Claude queries across agents during a session and surfaces it in a power-explained piece. Neither agent needed to coordinate explicitly — the shared memory did it.

---

## Limitations and Honest Notes

**Vectorize is a similarity search engine, not a database.** `/list` is approximate. Don't rely on it for authoritative inventory — that's what git is for.

**Mutation lag.** Upserts take a few seconds to become queryable. In the same session, don't upsert and immediately query the same memory expecting it back.

**No versioning in Vectorize.** Upserts fully replace. If you need history, store dated variants (`heartpunk-2026-03`, `heartpunk-2026-04`) rather than overwriting.

**Metadata filtering requires explicit indexes.** The `agent`, `namespace`, and `type` query filters use Vectorize `$eq` operators, which only work on fields with metadata indexes. Without them, filtered queries silently return empty. See setup step 2a — indexes must be created once per index, and re-upserts are needed for any pre-existing vectors.

**The zero-vector list trick.** `/list` uses a zero vector to approximate "give me everything." Results are ranked by distance from zero, not by recency or relevance. Treat list output as approximate inventory.

**Rebuild index command (when needed):**
```bash
# If index ever diverges from git-tracked memory files:
# 1. Delete all vectors (via Vectorize dashboard or REST API)
# 2. Re-run the ingestion script (to be written when needed)
# 3. All memory files in agent repos get re-embedded and re-inserted
```

---

## Files

```
agent-memory-worker/
  src/
    index.ts           ← Worker source (deploy this)
    memory-client.ts   ← Copy into agent repos
  wrangler.jsonc       ← Cloudflare config
  tsconfig.json
  USAGE.md             ← this file
```
