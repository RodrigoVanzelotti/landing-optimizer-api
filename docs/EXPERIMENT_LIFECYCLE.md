# Experiment lifecycle

The dashboard has six stages: waiting, running/paused, conclusive results awaiting
a decision, accepted changes, refused/reverted changes, and expired proposals.
Editors and administrators may start, pause, refuse and decide experiments.
There is no manual completion: the legacy complete endpoint rejects that action.
GET endpoints only read data; the background evaluator performs automatic writes.

## Observation and sufficient evidence

The experimental unit is an anonymous session assigned to one variant. Ambiguous
sessions exposed to multiple variants of the same experiment are excluded.
An exposure is analyzed after a complete 24-hour conversion window. A matching
goal after the exposure and before 24 hours counts once. The daily chart groups by
exposure date in UTC and accumulates these mature cohorts. It is not a fabricated
interpolation of aggregate results. Missing retained history blocks completion.

Before starting, the preceding 30 elapsed days of site visits and goal conversions
estimate the conversion baseline and the collection duration. Jeffreys smoothing
is used only for planning, never for observed KPIs. The visit-based floor per arm
is at least 30 sessions and the expected eligible traffic for seven days, using
allocation and the smallest normalized variant share. At least seven days of
mature exposures must also elapse. A rough fixed-sample 80%-power calculation for
a 10% relative effect estimates duration; it does not authorize completion.

With fewer than 30 baseline visits, the test collects a pilot. The evaluator
freezes a plan once sufficient pilot history exists and starts analysis afterward;
sessions first exposed during the pilot are excluded from the analyzed cohort.

Evidence uses a beta-binomial mixture confidence sequence with fixed Jeffreys
prior Beta(1/2,1/2). Invert

`B(s+1/2,n-s+1/2) / [B(1/2,1/2) p^s (1-p)^(n-s)] < 1/alpha`

for each Bernoulli rate. Allocate `alpha=0.05/number_of_arms` to cover all arms
simultaneously over continuous monitoring. See
[Howard et al., time-uniform confidence sequences](https://arxiv.org/abs/1810.08240).
The assumptions are stable instrumentation, randomized assignments and independent
session units; this does not compensate for a biased or broken event feed.

For control interval `[Lc,Uc]` and proposed interval `[Lv,Uv]`, a proposal is:

- improved when `Lv > 1.1*Uc`;
- declined when `Uv < 0.9*Lc`;
- equivalent within the relevant margin when `Lv > 0.9*Uc` and `Uv < 1.1*Lc`;
- still collecting otherwise.

Every proposal must resolve and satisfy the sample/time floor before automatic
completion. Nonsignificance alone never means equivalence. Results near a margin
can require a long collection; no arbitrary traffic coefficient forces a verdict.
Classical two-proportion p-values remain descriptive. The sequential evidence
determines the outcome labels and automatic completion.

## Final results and decisions

The evaluator checks once per minute while an API instance runs. An optimistic
status/timestamp update, the immutable JSON result snapshot, config invalidation
and the system audit event share a transaction. Concurrent evaluation or a user
pause cannot overwrite one another. Read/public-config requests do not advance
the lifecycle. If hosting scales to zero or suspends CPU, the central
infrastructure repository must arrange an always-running worker or scheduled
execution; no cloud scheduler is provisioned by this change.

`GET /analytics/experiments/:id/report` provides the authorized report, time series,
sampling plan and evidence. Final snapshots continue to work if event retention
expires or the event store is temporarily unavailable. The site collection and
legacy individual results endpoint use the same observation semantics.

`POST /experiments/:id/accept` requires a proposed `variantId` from that
experiment's conclusive snapshot. Multiple proposals require an explicit choice.
It records `accepted`, audits the decision and publishes only the chosen variant
with allocation and weight 1. Targeting stays intact. Reverting an accepted change
invalidates the config and restores the base on the snippet's next configuration
load. The result snapshot and original end time remain intact. Publication retries
can rebuild from the invalidated version; the snapshot never restarts data collection.

The signed config marks accepted experiments `permanent: true`. Deploy the paired
snippet patch `snippet-accepted-changes.patch` as well: the old snippet exits before
applying any changes to sessions outside analytics sampling. The patch applies
only signed permanent changes on those sessions, without tracking or creating a
session ID. Until that patch is applied and the snippet bundle is released, 100%
delivery is limited to clients whose installed analytics sampling is already 1.

Legacy `completed` records without a valid snapshot are labelled pending
verification and kept out of the results stage. The evaluator evaluates retained
history. A supported conclusion gets a snapshot; otherwise the record becomes
paused, with its former end time retained in the audit event. It never starts
traffic automatically or invents a successful result.

## Release

Apply `20261123140000_experiment_decisions` through the established central
infrastructure migration procedure before releasing this API/dashboard pair.
The additive migration introduces `accepted`, `evaluation_plan`, and
`result_snapshot`; it does not delete records or assign historical winners.
Regenerate Prisma when building. No deployment or database migration is performed
by the source change itself.
