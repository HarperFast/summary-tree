# Design

Invariants the code relies on and cannot state itself, why each holds, and where it is enforced. Configuration,
cost and endpoints are in [README.md](README.md).

## Sources

- **agent-memory is the only reader of `Memory`.** This plugin learns about memories through its sink
  (`registerMemorySink`, called inside each lifecycle transaction), `scanMemories` (the startup walk) and
  `getMemories` (current text and vectors, read by the runner and the leaf expand). Its own tables hold no memory text
  (`schema/summary.graphql`).
- **The sink only enqueues** (`recordMemory`, `src/store.ts`): one member-row read and write plus one or two change
  rows, all through the sink's `context` in the `memory` database, so they commit or roll back with the memory. No
  model call, no node read.
- **Every table has one writer role.** `SummaryMember` is written only by the sink and the startup walk, under the
  member row's node-scoped record lock (`lockRow`), which the sink takes after agent-memory's `Memory` locks; neither
  writer holds a `Memory` lock, so there is no cycle. `SummaryAssignment` (leaf per memory), `SummaryNode`,
  `SummaryPartition` and the expiry bookkeeping in `SummaryState` are written only by the leaseholding runner. The walk
  skips a scanned row recorded at a later revision, or at the same revision in the same state; at an equal revision
  in a different state it records the current row from `getMemories`, since two nodes can write one revision.
- **A member row keeps its `partition`, `status` and `flagged` after the memory becomes ineligible**: a later change
  needs them to know which partition to revoke.
- **The runner summarizes a memory only in a state at or behind its member row** (revision and `contentHash`,
  `Runner.rebuildPartition`). A newer state that `getMemories` returns committed together with its member row, so the
  runner re-reads that row; when the row is ahead, its pending change rebuilds what this pass builds.

## Visibility

- **One tree per exact label set** (`partitionLabels`, `src/partition.ts`); any set with `global` is `global`. Every
  member of a partition carries the node's labels, and withdrawn and flagged memories are never summarized, so for a
  node agent-memory's full read rule reduces to `canReadLabels(principal, node.labels)` (`Barriers.read`, `src/serve.ts`). A node also stops being served at `expiresAt`, the earliest `validUntil` of its
  sources, without waiting for a rebuild.
- **A pending revoking change hides its whole partition** on every surface (`Barriers`). A change revokes
  when the memory was withdrawn, newly content-flagged, or moved to another label set, judged against the stored
  member, not its eligibility (`revokesFrom`): a summary may still carry text from a member that became ineligible
  for another reason, and the later withdrawal must still revoke.
- **Each serving request reads in one snapshot** (`inSnapshot`, `src/serve.ts`): Harper gives every read in one
  transaction on one database a consistent snapshot, so a request's barrier decisions and the summary text it returns
  are one point in time. Within it, serving reads node metadata without text, skips a node that cannot fit
  the budget (`textChars`), checks the node's partition for a pending revoke (`Barriers`: one lookup on the `revokePartition` index per
  partition, memoized for the request, never capped, so one tenant's burst hides nothing of another's), then reads
  the node.
- **Hiding is replica-local, like agent-memory's own reads.** The change row is written in the memory's transaction
  in the same database, so a node stops serving the partition when that replica of the memory changes. No serving
  path waits on another node.
- **A sink only sees its own node's writes.** Two nodes moving one memory to different label sets at once each revoke
  the partition they saw it leave; after replication, one partition may still hold its text with no revoke. The
  runner closes that: for each memory whose change it processes, any node in another partition whose `sourceIds`
  name it, where it is no longer an eligible member, gets a revoke change (`#orphanedPartitions`). The window is
  replication lag plus one pass; agent-memory's `lockScope: cluster` prevents the concurrent writes.
- **A worker serves nothing until its startup walk finishes** (`Runner.ready`), so a change made while the plugin was
  not loaded is recorded, and its partition hidden if it revokes, before any summary is served.

## Rebuilds

- **A partition's changes are read before its members, and deleted last**, in their own lease-fenced transaction
  after the nodes they require are published and the assignments written (`Runner.rebuildPartition`). A change
  committed after the member read is not deleted, so it keeps a revoked partition hidden until the next pass rebuilds
  from member state that includes it. A failure or crash at any step leaves the changes, so the partition stays
  hidden if they revoke, and the next pass repeats the work.
- **`sourceIds` is a node's text provenance**: every memory its summary was derived from, directly or through
  children, as of its last summarization. A node that keeps its text keeps its `sourceIds`. Any node whose
  `sourceIds` include a revoked memory is re-summarized (`builtFromRevoked`, `src/plan.ts`), at any level, whatever
  the current assignments say.
- **Text never outlives its sources.** A leaf whose `builtFrom` names a memory that is no longer an eligible member in
  that state (`memberRef`: id, revision, content hash) is re-summarized (`leafNode`, `src/plan.ts`); only members that joined wait for
  `max(dirtyMin, dirtyFraction × size)` (`membershipDelta`). Interior nodes are re-summarized whenever a child is or
  their child set changes.
- **Ids are stable**: a re-cluster pairs each new group with the old node sharing most members (`matchByOverlap`).
- **One runner at a time.** The lease row is read and written under the runner record lock (`lockRunner`:
  cluster-exclusive when Harper has record-lock transport, node-exclusive otherwise), renewed before each model call,
  and renewed through that lock inside every publish transaction (`#assertLease`). In Harper 5.4's source a write
  staged through an expired lock handle is refused at commit (409); that is observed behavior, not a documented
  promise, so the lease also bounds how stale a holder can be. Without cluster locks, two nodes can both hold the lease within replication lag, and a stale
  publish replicates over a newer one; the `runner: false` option confines rebuilds to one node there. Record locks
  need RocksDB, as agent-memory's own lifecycle writes do.
- **No plugin transaction holds two member locks.** The startup walk takes one per transaction. agent-memory's
  multi-memory operations can make the sink take several, in their order, so a second multi-lock holder could
  deadlock with it.
- **Scheduling is event-driven**: a `SummaryChange` subscription debounces a tick; a tick with no changes and no
  expired members does nothing; the only idle timer is the next `validUntil` (`#armExpiry`). Expiry needs no member
  write: the runner keeps the time up to which it has handled expiries (`SummaryState` `expiry`), and `getMemories`
  state excludes an expired memory from every rebuild. Failures back off
  exponentially while work remains.
- **Clustering yields to the event loop** (`kmeans`, `src/kmeans.ts`) so a large partition does not stall the worker
  that also serves requests.

## Prompts

- **Memory text is untrusted data.** Each item is a JSON string literal with `<` and `>` escaped, so it cannot close
  the `<data>` element or start a new line; the system message tells the model to ignore instructions inside it
  (`buildPrompt`, `src/summarize.ts`). Summaries go back to agent-memory, which frames contributed text as stored
  data; the plugin adds no second framing.
- **Prompts are sized from `contextTokens`** (`promptInputChars`, `src/settings.ts`): members are ordered most central
  first, so the budget drops the least representative.
