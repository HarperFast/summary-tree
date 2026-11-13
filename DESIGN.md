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
- **Member rows are written under their node-scoped record lock** (`lockRow`) by the sink, the startup walk and the
  runner's leaf assignment. The walk applies a scanned row only when it is newer than the stored member, so a walk
  that read revision N cannot overwrite a sink's N+1. The sink takes this lock after agent-memory's `Memory` locks;
  no member-row writer holds a `Memory` lock, so there is no cycle.
- **A member row keeps its `partition`, `status` and `flagged` after the memory becomes ineligible**: a later change
  needs them to know which partition to revoke.
- **The runner summarizes a memory only at the revision its member row records** (`Runner.rebuildPartition`). A
  memory `getMemories` returns at another revision, or no longer eligible, changed after its member row was written;
  its own change row is pending and the next pass handles it.

## Visibility

- **One tree per exact label set** (`partitionLabels`, `src/partition.ts`); any set with `global` is `global`. Every
  member of a partition carries the node's labels, and withdrawn and flagged memories are never summarized, so for a
  node agent-memory's full read rule reduces to `canReadLabels(principal, node.labels)` (`servable`, `src/serve.ts`).
- **A pending revoking change hides its whole partition** on every surface (`blockedPartitions`). A change revokes
  when the memory was withdrawn, newly content-flagged, or moved to another label set, judged against the stored
  member, not its eligibility (`revokesFrom`): a summary may still carry text from a member that became ineligible
  for another reason, and the later withdrawal must still revoke.
- **Hiding is replica-local, like agent-memory's own reads.** The change row is written in the memory's transaction
  in the same database, so a node stops serving the partition when that replica of the memory changes. No serving
  path waits on another node.
- **A worker serves nothing until its startup walk finishes** (`Runner.ready`), so a change made while the plugin was
  not loaded is recorded, and its partition hidden if it revokes, before any summary is served.

## Rebuilds

- **A partition's changes are read before its members, and deleted only in the transaction that publishes every node
  they require** (`Runner.rebuildPartition`). A change committed after the member read is not deleted, so it keeps a
  revoked partition hidden until the next pass rebuilds from member state that includes it. A failed model call or a
  lost lease publishes nothing and deletes nothing.
- **`sourceIds` is a node's text provenance**: every memory its summary was derived from, directly or through
  children, as of its last summarization. A node that keeps its text keeps its `sourceIds`. Any node whose
  `sourceIds` include a revoked memory is re-summarized (`builtFromRevoked`, `src/plan.ts`), at any level, whatever
  the current assignments say.
- **Ids are stable**: a re-cluster pairs each new group with the old node sharing most members (`matchByOverlap`), and
  a node keeps its text while fewer than `max(dirtyMin, dirtyFraction × size)` members changed since its `builtFrom`
  (`membershipDelta`). Interior nodes are re-summarized whenever a child is or their child set changes.
- **One runner at a time.** The lease row is read and written under `SummaryState.lock` (cluster-exclusive when
  Harper has record-lock transport, node-exclusive otherwise, skipped on LMDB), renewed before each model call, and
  checked inside every publish transaction (`#assertLease`). Without cluster locks two nodes can briefly both hold
  it; the fence makes the loser publish nothing.
- **Scheduling is event-driven**: a `SummaryChange` subscription debounces a tick; a tick with no changes and no
  expired members does nothing; the only idle timer is the next `validUntil` (`#armExpiry`). Failures back off
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
