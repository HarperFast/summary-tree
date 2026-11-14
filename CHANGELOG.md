# Changelog

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
