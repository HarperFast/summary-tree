# Changelog

## 0.2.2

- **Upgrades rewrite old summaries.** Every summary node records the summarizer version that wrote it. On startup,
  each worker queues a rebuild of every label set that holds a node from an older version, or from before nodes were
  stamped. That rebuild re-summarizes those nodes in place: their ids, topics and memory assignments stay the same.
  Upgrading from 0.2.0 or 0.2.1 re-summarizes every stored node once, so summaries cut off mid-sentence and topics
  whose summary only repeated their title get rewritten. Old text keeps being served until its replacement is
  published.
- **Title-only replies are rejected.** A model reply with a `TITLE:` line and nothing after it, or with a body that
  only repeats the title, is no longer stored as the summary. The runner asks once more, telling the model its reply had
  no summary. If the second reply has none either, the rebuild fails and is retried later, and the previous text stays.

## 0.2.1

- **Orientation leaves room for recent memories.** The bootstrap `orientation` section fills at most half of the
  budget agent-memory passes it (new option `orientationShare`), so `recent` and `relevant` keep the rest. Before,
  orientation could take all of it.
- **Orientation items are short.** Each item is the topic title, the first sentence of its summary (at most 200
  characters), and its `(<n> memories; summary node <id>)` reference, instead of the full summary.
- **No single-root trees.** Planning no longer adds a level that would hold one node; the level below becomes the
  top, so orientation shows its topics instead of one generic root. Trees stored by 0.2.0 in that shape lose the root
  on the first pass after startup, with no model calls; a client holding the root's id gets 404 afterwards.
- **Complete sentences.** The summary prompt states its length in words and sentences sized under
  `maxSummaryTokens`, and a summary cut off at the token cap or the 2,000-character cap is stored up to its last
  complete sentence. Summaries already stored keep their text until they are next rebuilt.
- When agent-memory passes the client's per-item framing cost (`itemOverheadChars`, newer than 0.1.5), orientation
  counts it for every item after the first.
- Settings reject `NaN` for numeric options.
