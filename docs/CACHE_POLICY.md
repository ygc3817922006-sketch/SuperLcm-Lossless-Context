# Cache-aware persistent context policy

This document defines the rolling policy used by `dsh-lossless-context` for a long-lived coding worker. The goal is not to minimize prompt size at any cost. It is to keep the model-visible context small enough to remain useful while avoiding unnecessary destruction of a warm provider prefix cache.

## Starting profile for GPT-5.6 Sol

```yaml
mode: rolling
tailCount: 24
minRetainTokens: 32000
pressureFoldTokens: 20000
foldBatchTokens: 64000
softActiveTokens: 160000
hardActiveTokens: 220000
cacheTtlSeconds: 1800
foldTiming: background
```

These are starting values, not universal constants. They are intentionally tuned for a large-context persistent worker; smaller-context models should use proportionally smaller pressure limits.

## What each number means

`tailCount=24` keeps at least the newest 24 surface nodes verbatim during normal rolling maintenance. `minRetainTokens=32000` is an independent token floor, so 24 tiny messages cannot leave the model with an impoverished recent working set.

`foldBatchTokens=64000` is the normal surface-mutation granularity. A cache-hot request below the soft pressure boundary does not rewrite the active prefix merely because 20k of history became foldable.

`pressureFoldTokens=20000` is the minimum useful reduction admitted once the active context reaches `softActiveTokens=160000`. At that point context quality/size takes priority over preserving a hot prefix.

`hardActiveTokens=220000` is a safety boundary. Above it, any balanced non-empty reduction is admitted. Only at this hard boundary may the 24-node preference relax to one recent node; the 32k recent-token floor and tool-pairing boundary remain mandatory.

`cacheTtlSeconds=1800` is a heuristic, not provider telemetry. The engine records the previous agent pre-step time. A first observed step is treated as hot. A later step after a gap greater than the TTL is a cold-cache opportunity. Set the value to zero to disable this deferral.

## Admission order

For each pre-step the engine measures the canonical DSH request surface, derives a safe balanced head range, then applies this priority:

1. `hard-cap`: active tokens are at or above the hard boundary. Commit synchronously.
2. `soft-cap`: active tokens are at or above the soft boundary and the foldable head is at least `pressureFoldTokens`. Commit synchronously.
3. `cold-batch`: cache is considered cold and the foldable head is at least `foldBatchTokens`. With `foldTiming: background`, this may run concurrently with the next request.
4. Otherwise leave the surface unchanged.

Pressure folds are deliberately synchronous even when background mode is selected. DSH's official automatic `compactRegion()` transaction validates whole-surface stability; a pressure limit must not depend on whether an asynchronous summary wins a race with the next assistant/tool append.

A `cold-batch` background fold is opportunistic. If the surface changes while its summary is being prepared, DSH rejects the commit. The raw session remains canonical and the policy simply retries on a later step.

## 20k leaf summaries versus 64k surface commits

The desired long-term architecture separates two concepts:

- roughly 20k tokens as a leaf-summary granularity;
- roughly 64k tokens as the granularity at which the active model surface is actually rewritten.

The current alpha implements the second part safely but does **not** manufacture detached 20k leaf summaries. DSH's official transaction currently couples summarization to `compactRegion()`: a summary becomes authoritative only when the selected span is transactionally replaced on the surface. Creating hidden leaf summaries outside that transaction would introduce a second authority path and weaken the lossless contract.

A future leaf-preparation layer should therefore have an explicit non-authoritative staging contract, then atomically promote prepared leaves only through a normal DSH compaction transaction. Until that contract exists, `pressureFoldTokens=20000` means “minimum useful pressure reduction”, not “background leaf size”.

## Interaction with PTC / Code Mode

Programmatic Tool Calling (PTC) is complementary to this policy. PTC should filter, aggregate, and parallelize mechanical tool work before returning to the model. Large grep output, file scans, test logs, and intermediate tool results should remain inside the code-mode runtime whenever possible, with only the useful conclusion returned to the active conversation.

That reduces context generation at the source. Lossless context then preserves the genuinely useful history and exact recall path instead of spending most of its budget summarizing disposable tool noise.

Recall tools should follow the same principle: search narrowly first, expand bounded pages, and when PTC is available filter expanded material inside the program before returning it to the model.

## What cache-aware means here

This implementation is deliberately conservative. It does not claim to know whether OpenAI or another provider actually retained a cache entry. It only avoids frequent prefix mutations when recent step timing makes a warm cache plausible.

Provider-reported cache telemetry can be added later, but it must remain an optimization signal. Active-context pressure and correctness are hard constraints and always override cache preservation.

Useful future metrics include active tokens, foldable tokens, retained-tail tokens, admission reason, surface mutations per hour, summarizer latency, provider cached-input tokens, and cache-write tokens. Those metrics should be collected before further tuning the default thresholds.
