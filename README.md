# @harperfast/summary-tree

Topic summaries over [@harperfast/agent-memory](https://github.com/HarperFast/agent-memory): a Harper plugin that
clusters stored memories by embedding, has a generative model summarize each cluster, and serves the result so an
agent starting a session knows what is stored before it asks.

- **Orientation at session start.** `GET /Memory/bootstrap` gains an `orientation` section: the top levels of every
  summary tree the caller can read, largest topics first, each as its title and the first sentence of its summary,
  inside half of the caller's remaining character budget (`orientationShare`). Clients get it with no change;
  agent-memory frames it as stored data like any memory.
- **Topic beside each search hit.** Search results (`GET /Memory/?q=`, MCP `recall`) carry a `summaryTree` field on
  each hit: the topic it belongs to, its summary and how many memories share it.
- **Open a topic.** `GET /SummaryTree/<id>` returns a summary node with its subtopics, or the ids and titles of its
  memories. An MCP tool, `expand_summary`, does the same.

Summaries never change a memory. They are derived, read-only, and rebuilt as memories change.

## Install

The plugin runs beside agent-memory 0.1.5 or later (for `scanMemories`, `getMemories`, bootstrap sections and search
annotators), in the same app or another app on the same Harper (5.3.1 or
later; 5.4 for cluster-wide runner locks). Add both to an app's `config.yaml`, or this plugin alone to a second app
whose `node_modules` also holds agent-memory:

```yaml
'@harperfast/agent-memory':
  package: '@harperfast/agent-memory'

'@harperfast/summary-tree':
  package: '@harperfast/summary-tree'
  generativeModel: default # a models.generative entry in harper-config.yaml
  contextTokens: 32768 # that model's context window
```

It needs a generative model and an embedding model in Harper's `models:` configuration. Its tables live in
agent-memory's `memory` database and replicate with it.

**Multi-node clusters** need Harper's record-lock replication and agent-memory's `lockScope: cluster`. agent-memory
calls the plugin's sink only on the node that makes a change. Under node-scoped locks, two nodes can change one memory
at once, for example moving it to two different label sets. Summary text can then stay in the partition it left until
replication lands and the runner's next pass revokes that partition. Without record-lock replication, also set
`runner: false` on every node but one. The plugin cannot read agent-memory's `lockScope`, so it cannot enforce this.

## Configuration

Options go under the `'@harperfast/summary-tree'` key. A malformed change is logged and the previous configuration
keeps running; `urlPath` and `mcp` take effect on restart.

| Option             | Default       | Meaning                                                                                                                                                                                             |
| ------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generativeModel`  | `default`     | Logical generative model that writes summaries                                                                                                                                                      |
| `embeddingModel`   | `default`     | Logical embedding model; a memory's stored vector is reused when agent-memory embedded it with this model                                                                                           |
| `contextTokens`    | `8192`        | The generative model's context window; sizes each prompt                                                                                                                                            |
| `charsPerToken`    | `3`           | Characters per token used to turn `contextTokens` into a character budget (conservative for English)                                                                                                |
| `maxSummaryTokens` | `400`         | Output tokens per summary. The prompt asks for at most `maxSummaryTokens / 2.5` words (110 for a leaf, 130 above, at most); a summary cut off at the cap is stored up to its last complete sentence |
| `orientationShare` | `0.5`         | Share of the budget agent-memory passes the orientation section that orientation may fill, leaving the rest for `recent` and `relevant` (unused when the caller has none)                           |
| `memberChars`      | `2000`        | Characters of each memory (title and content) available to a prompt                                                                                                                                 |
| `leafClusterSize`  | `15`          | Target memories per leaf topic                                                                                                                                                                      |
| `fanout`           | `10`          | Target topics per parent above the leaves                                                                                                                                                           |
| `topFloor`         | `6`           | Stop adding levels once a level has at most this many nodes, or when the next level would have only one                                                                                             |
| `treeMinMembers`   | `40`          | A label set with at least this many memories gets a clustered tree                                                                                                                                  |
| `flatMinMembers`   | `3`           | A label set with at least this many (and fewer than `treeMinMembers`) gets one summary; fewer get none                                                                                              |
| `dirtyMin`         | `2`           | A node is re-summarized after at least `max(dirtyMin, dirtyFraction × size)` member changes                                                                                                         |
| `dirtyFraction`    | `0.15`        | See `dirtyMin`                                                                                                                                                                                      |
| `rebuildGrowth`    | `2`           | Re-cluster a tree when its label set has grown or shrunk by this factor since the last clustering                                                                                                   |
| `debounceMs`       | `30000`       | Wait after a change before rebuilding, so a burst of writes costs one pass                                                                                                                          |
| `leaseMs`          | `300000`      | How long the runner lease lasts between renewals                                                                                                                                                    |
| `runner`           | `true`        | Whether this node rebuilds summaries. In a cluster without record-lock replication, leave it on for one node only                                                                                   |
| `urlPath`          | `SummaryTree` | REST path of the expand endpoint                                                                                                                                                                    |
| `mcp`              | `false`       | Mount the `expand_summary` MCP tool on Harper's `/mcp` endpoint (needs Harper's MCP server enabled)                                                                                                 |

## Permissions

A memory belongs to one **partition**: its exact, sorted set of scope labels. Any set containing `global` is the
`global` partition, since agent-memory lets a caller read a memory when any of its labels is readable. Each partition
gets its own tree, so a summary only ever mixes memories that carry the same labels.

Every node carries its partition's labels, and a caller sees it exactly when agent-memory's
`canReadLabels(principal, labels)` is true: that is when the caller can read every memory in it. A reader of
`customer:acme` never sees a node built from `customer:beta` memories. Every surface (orientation, annotations, the
REST and MCP expand endpoints) resolves the caller with agent-memory's `resolvePrincipal` and applies that test; a
node the caller cannot read answers 404, the same as one that does not exist.

Withdrawn, superseded, expired, review-flagged (`needsReview`) and customer-content-flagged memories are left out of
summaries until cleared. When a member is **withdrawn, content-flagged or moved to other labels**, its old partition
is hidden from every surface in the same transaction that makes the change, and stays hidden until it is rebuilt
without that memory; other partitions keep serving.

## Freshness

agent-memory calls the plugin's sink inside each memory change's transaction. The sink makes no model call: it
updates the memory's assignment row (partition, topic, revision; no memory text) and appends a change row, both in the
`memory` database, so they commit or roll back with the memory. A debounced runner then rebuilds only the partitions
with pending changes, reading current memory text and vectors from agent-memory with `getMemories`:

- Below `rebuildGrowth`, new memories join the nearest existing topic and node ids stay the same. A re-cluster matches
  new topics to old ones by shared members and keeps their ids, so clients can hold on to a node id.
- Summary text never outlives its sources: a node is rebuilt as soon as a memory it was built from is edited,
  withdrawn, superseded, flagged, expired, marked for review or moved. New memories only wait: a node keeps its text,
  with no model call, until at least `max(dirtyMin, dirtyFraction × size)` members have joined or changed.
- Expiry (`validUntil`) has no event; the runner keeps one timer for the next expiry. Nothing runs while nothing is
  pending.
- On startup each worker walks agent-memory's memories (`scanMemories`) to catch changes made while the plugin was not
  loaded, and serves nothing until that walk finishes.

One worker runs the rebuilds at a time, under a lease checked again, under the runner's record lock, inside every
publish transaction. With Harper's record-lock replication configured that lock is cluster-wide. **Without it, set
`runner: false` on every node but one**: two nodes could otherwise both hold the lease within replication lag, and a
publish from stale state can replicate over a newer one. Each node stops serving a hidden partition exactly when its
own copy of agent-memory stops serving the memory: the change row replicates in the same transaction as the memory.

## Cost

| Event                                                                               | Model calls                                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Any memory write                                                                    | none; the sink adds one record lock, one read and two or three small writes to the memory's transaction |
| New memory                                                                          | none until its leaf is dirty; no embedding while `embeddingModel` matches agent-memory's                |
| Leaf crosses its dirty mark                                                         | one summary for the leaf, plus one per ancestor level (at most 2 for a few thousand memories)           |
| Edit, withdraw, supersede, flag, expiry, review flag or move of a summarized memory | one summary for its leaf plus one per ancestor level                                                    |
| Re-cluster (size ×2 or ÷2)                                                          | one per new or changed topic; topics that kept their members keep their text                            |

`debounceMs` batches these: several changes to one leaf inside the window cost one call per affected node. The first
build of a 2,000-memory partition makes about 150 calls (≈ n/15 leaves plus ≈ n/150 above them).

Serving cost grows with the number of summarized label sets, not with memories: bootstrap reads every top node's
labels and size, then for each node that fits the budget checks its partition for a pending revocation (one indexed
lookup per partition, cached for the request) and reads its text. Measured 2026-11-13 (`scripts/bench-serving.mjs`,
one Harper 5.4 worker, local): bootstrap p50 2.2 ms with 10 label sets and 8.6 ms with 1,000 (3,040 memories; 12.1 ms
for a super user who reads all 1,000); search with annotations 5.0 ms and 5.5 ms. A memory write
(`PUT /Memory/<id>`, 100 label sets) took 4.8 ms p50 without the plugin and 7.1 ms with it, using the fixtures' instant
embedding model and with the runner rebuilding during the run; a real embedding call adds far more than either.

## Endpoints

- `GET /SummaryTree/` → `{ nodes: [...top nodes the caller can read, largest first, at most 200], truncated, pending }`. `pending` is true while a readable
  partition has changes not yet applied; it reads at most 1,000 pending changes, so behind a larger backlog it can be
  false early.
- `GET /SummaryTree/<id>` → `{ node, children }` for a node with subtopics, `{ node, members: [{ id, title }] }` for a
  leaf. A node is `{ id, title, summary, level, memberCount, parentId }`.
- MCP `expand_summary { id? }` → the same as the two routes above.
- Search hits gain `summaryTree: { id, title, summary, level, memberCount, parentId }`.
- Bootstrap's `orientation` items are `{ title, content: "<gist>\n(<n> memories; summary node <id>)" }`. The gist is the
  summary's first sentence, or at most 200 characters cut at a word and ending in `…`; the full summary is one
  `GET /SummaryTree/<id>` or `expand_summary` away. When agent-memory reports its per-item framing cost
  (`itemOverheadChars`, newer than 0.1.5), orientation counts it for every item after the first.

## Evaluation

`scripts/eval-orientation.mjs` seeds a synthetic corpus (30 topics, 255 memories, skewed topic sizes) into a local
Harper with real models and counts the topics named in bootstrap's output at a fixed budget. Without orientation that
is the caller's recent memories; with it, the orientation section takes its share first and `recent` fills what is
left. Measured 2026-11-14 with `llama3.2:3b-ctx8k` and `nomic-embed-text` on Ollama (13 top-level topics):

| Budget (chars) | Topics covered without | Topics covered with | Recent memories kept with |
| -------------- | ---------------------- | ------------------- | ------------------------- |
| 2,000          | 7 / 30                 | 8 / 30              | 5                         |
| 4,000          | 11 / 30                | 20 / 30             | 9                         |
| 8,000          | 16 / 30                | 29 / 30             | 23                        |

0.2.0 packed full summaries into the whole budget and covered 16, 21 and 24 topics; `recent` got only what they left
(none in the 4,000-character deployment measurement that prompted 0.2.1).

## Development

```sh
npm install
npm test                 # build + unit tests (in-memory Harper and agent-memory stand-ins)
npm run test:integration # packs the plugin, runs agent-memory and this plugin as two apps on a real Harper
npm run eval:orientation # needs local models; see the script's header
```

The integration fixtures install the agent-memory version this checkout has in `node_modules` (or `AGENT_MEMORY_TARBALL`). To test an already-packed plugin instead of the checkout, run `node scripts/install-fixtures.js <tarball>` and then `npm run test:integration:run`, which runs the suite without rebuilding or repacking.

## Releasing

Publishing a GitHub release tagged `v<package.json version>` runs `.github/workflows/release.yml`: it tests the packed tarball, then publishes it to npm with provenance (`next` for a prerelease version, otherwise `latest`). Publish releases one at a time, in version order. Auth is npm trusted publishing, which needs one-time setup:

1. A `Release` environment in the repository settings (the publish job runs in it; add required reviewers there to gate publishing).
2. A trusted publisher on the npm package: repository `HarperFast/summary-tree`, workflow `release.yml`, environment `Release`, with direct `npm publish` allowed (npm allows only `npm stage publish` by default). npm only offers this on a package that already exists, and expires a configuration whose first publish does not succeed within 2 days, so add it shortly before the next release.

See [DESIGN.md](DESIGN.md) for the invariants the code relies on.
