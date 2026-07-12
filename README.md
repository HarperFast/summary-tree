# summary-tree

Reference implementation of the RAPTOR-style **summary tree** retrieval pattern from
[harper#1244](https://github.com/HarperFast/harper/issues/1244) (Thread B) — hierarchical,
"zoom-out" retrieval as a **pure Harper application**: no core changes, no external
services beyond the configured models.

Retrieval over a flat chunk index answers *"what does `searchLayer` return?"* well and
*"what does this codebase do?"* badly. This component adds the missing layer: chunks are
clustered by embedding, each cluster is LLM-summarized into a `Summary` row (itself
embedded and HNSW-indexed by `@embed`), recursively, giving broad queries real summary
nodes to land on. The [pre-gate evaluation](https://github.com/HarperFast/harper/issues/1244#issuecomment-4949385426)
measured 2.4× thematic topic coverage at the same token budget with no factoid regression
at k≥5.

Unlike the published RAPTOR (batch/static), this tree is **live**: chunk writes are
assigned to the nearest cluster centroid via a table subscription, clusters dirty-mark,
and a periodic pass re-summarizes only dirty clusters (~4 LLM calls for a typical
single-source update vs a full rebuild).

## How it works

- **`schemas.graphql`** — `Chunk` (content + `@embed` vector + `summaryId` leaf link) and
  `Summary` (LLM text + `@embed` vector + `level`, `parentId`, stored k-means `centroid`,
  `dirtyCount`). Two tables, not one: the pre-gate showed the two-table merge is
  metric-for-metric identical to a shared table, and it keeps `Chunk` an ordinary content
  table.
- **`resources.js`**
  - `RagSearch` — `GET /RagSearch?q=...&limit=10&mode=mixed|chunks|summaries`. Embeds the
    query (`models.embed`, `inputType: 'query'`), vector-searches both tables, merges by
    exact cosine distance.
  - `TreeStatus` — `GET /TreeStatus`: chunk/summary counts by level, dirty count, build
    metadata.
  - Maintenance loop — every 30s (leader-elected via a lease row; see frictions):
    full build when a tree doesn't exist yet (≥40 chunks) or the corpus has ~2×'d;
    otherwise sweep unassigned chunks + re-summarize dirty clusters (leaves first,
    dirtiness propagates to parents).
  - Chunk subscription — real-time nearest-centroid assignment of new/updated chunks.
- **`lib/kmeans.js`** — spherical k-means (k-means++, deterministic seed, tiny-cluster
  merge). **`lib/summarize.js`** — prompt/parse around `models.generate`.

## Running it

Requires a models config in the instance's `harper-config.yaml` — any embedding +
generative backends work; local Ollama shown:

```yaml
models:
  embedding:
    embedder:            # logical name the schema's @embed(model: "embedder") refers to
      backend: ollama
      host: localhost:11434
      model: nomic-embed-text:latest
  generative:
    summarizer:          # logical name the build loop's generate() calls use
      backend: ollama
      host: localhost:11434
      model: llama3.2:3b
      requestTimeoutMs: 120000
```

```sh
harper dev /path/to/harper-summary-tree
# write content
curl -X PUT https://localhost:9926/Chunk/doc1-0 -u admin:pw \
  -H content-type:application/json \
  -d '{"text": "...", "source": "doc1.md", "title": "Doc 1 §intro"}'
# ...the tree builds/updates itself; then:
curl -k "https://localhost:9926/RagSearch?q=how%20does%20replication%20work&limit=10"
curl -k  https://localhost:9926/TreeStatus
```

`scripts/load-corpus.js` bulk-loads a JSONL corpus through the REST write path
(embedding runs server-side).

## Tuning

| constant (resources.js) | default | meaning |
|---|---|---|
| `TARGET_CLUSTER_SIZE` | 15 | chunks per level-1 cluster (k = n/15) |
| `HIGHER_FANOUT` / `TOP_FLOOR` | 10 / 6 | recursion shape above level 1 |
| `MIN_CHUNKS_FOR_TREE` | 40 | below this, stay flat |
| `DIRTY_MIN` / `DIRTY_FRACTION` | 2 / 0.15 | re-summarize threshold per cluster |
| `REBUILD_GROWTH` | 2 | full re-cluster after corpus doubles |
| `MAINTENANCE_INTERVAL_MS` | 30s | periodic pass cadence |

## Demo-environment notes (from the live run)

- **Ollama context window**: the Harper ollama backend passes only `temperature`/`maxTokens`
  — it cannot set `num_ctx`, and ollama's 2048-token default **silently truncates** long
  summarization prompts (symptom: meta-language titles like "Based on the provided code…"
  on large clusters only). Fix: `ollama create llama3.2:3b-ctx8k -f <Modelfile with
  PARAMETER num_ctx 8192>` and reference that model in the config.
- On a shared dev box, give the instance unique ports:
  `--HTTP_PORT=127.0.0.1:19926 --OPERATIONSAPI_NETWORK_PORT=127.0.0.1:19925
  --MQTT_NETWORK_PORT=127.0.0.1:11883 --MQTT_NETWORK_SECUREPORT=127.0.0.1:18884`
  (note: explicit `HTTP_PORT` serves plain HTTP; the secure ops listener still defaults
  to 9925 — non-fatal if taken).
- `harper dev` watches the app directory: **any file edit restarts the app mid-build**.
  The `builtAt` completion marker exists precisely so interrupted builds rebuild.

## Known limits / core frictions (tracked in #1244)

1. **Bulk vector access**: the build loop iterates records to collect embeddings
   (decodes whole records for one attribute). The HNSW index store holds int8-quantized
   copies that reconstruct at ~1% error — adequate for clustering (measured: perturbs
   k-means less than its own seed instability) — but there is no supported scan API yet.
   Fine to low-hundreds-of-thousands of rows; sample-based k-means beyond that.
2. **Query-time embedding**: `RagSearch` embeds the query itself; the search path has no
   text→vector integration.
3. **No scheduler primitive**: the maintenance pass self-schedules with `setInterval`
   plus a lease row (`TreeState`) so only one worker runs it.
4. **Multi-node**: the tree builds on whichever node holds the lease; `Summary` rows
   replicate like any table. Subscription-driven assignment runs node-locally.
5. Deletes rely on the periodic sweep/dirty pass rather than exact event-time
   bookkeeping (the delete event doesn't carry the old `summaryId`).
