# azentio.ai learning pipeline demo

A local, free, synthetic-data prototype of the client observation → moderation → approved shared learning → withdrawal flow.

## Run locally

Requires Node.js 20 or newer. No package install is needed.

```powershell
node server.mjs
```

## Demo accounts

All accounts use the demo password `demo123`.

| Role | Login | Organisation |
|---|---|---|
| Client member | `client-a` | Northstar Finance |
| Client member | `client-b` | BlueRiver Bank |
| Client member | `client-c` | Cedar Trust |
| Learning moderator | `moderator` | Platform moderation |
| Product owner | `owner` | Financial Analysis Intelligence |

## Demo walkthrough

1. Sign in as `client-a`; save a private draft and confirm it remains private.
2. Create another observation, choose proposed community sharing, and submit for review.
3. Sign in as `moderator`; redact the shared copy and approve it.
4. Sign in as `client-b`; find the approved copy in the shared learning feed. Search or filter by offering, industry, region, period, and topic.
5. Submit and approve matching observations from `client-b` and `client-c`. The emerging themes panel displays a topic only after it has approved contributions from at least three distinct organisations.
6. Sign in as `client-a`; withdraw the contribution and confirm it disappears from future feed/search results.
7. Sign in as `owner`; link the approved contribution to an improvement idea and update its status.

The theme threshold is at least three organisations and cannot be lowered with `MIN_THEME_ORGS`. The demo displays aggregate counts and does not claim that a theme proves market prevalence or causation.

Moderators and product owners can inspect the most recent audit events in their workspace. Audit history is read-only in the interface; events are recorded for demo workflow actions such as submissions, moderation decisions, publishing, withdrawal, reports, and improvement updates.

Clients can report an active shared contribution. Moderators can dismiss a report while leaving the item published, temporarily unpublish it during review, then restore it or keep it unpublished. Each action requires a decision note, is audited, and notifies the contribution's author in-app. A contributor withdrawal takes precedence; report review cannot republish a withdrawn item.

Clients can edit private drafts and clarification-returned observations. A returned item leaves the moderator queue until the client amends it and explicitly reconsents to community sharing before resubmission.

For an active published contribution, its author can propose a new version with renewed community-sharing consent. The current approved copy remains available during review; approval supersedes it with the reviewed version. Only one version per contribution can be in review at a time, and withdrawing the contribution withdraws the full version lineage.

The contribution form now records storage/processing permission separately from community-publication permission. Attribution and model-training permission remain off. Each client observation shows its current audience and any recorded consent timestamps; older synthetic records are labelled as legacy where timestamp history was not stored.

## Demo limitations

- Identity is a local demo login with fixed synthetic accounts, not OIDC or managed email verification.
- Data is written to `data/store.json`; it is synthetic and for the local demo only.
- Sessions live in server memory and end when the server restarts.
- The app has no production security review, external email, attachments, AI provider, or deployment configuration.
- API authorization checks run server-side and tenant/author boundaries are enforced for the demo flow. Do not put real client or personal data into this app.
