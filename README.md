# yc-directory-sync

Pulls newly-launched Y Combinator companies (filtered by batch, industry, and
region) into a Clay table automatically, on a daily schedule, at zero ongoing
cost. No headless browser, no Apify, no per-page scraping fee.

## How it works

```
[YC's own Algolia search index] --query--> [Cloudflare Worker] --new companies only--> [Clay webhook]
                                                  ^        v
                                           [Cron Trigger] [KV: seen IDs]
```

YC's directory page (`ycombinator.com/companies`) is powered by a public,
read-only Algolia search key embedded directly in the page source, the same
one their own filter UI calls. Instead of rendering the page and scraping
it, this Worker queries that index directly.

On every run:
1. Query Algolia for companies matching the configured batches, industries,
   and regions.
2. Compare the results against a list of company IDs already sent, stored in
   Workers KV.
3. Push only the new ones to a Clay webhook, one company per request.
4. Update KV with whatever was actually delivered.

The very first run has an empty KV, so everything matching the filters
counts as new, that run **is** the backfill. No separate backfill mode
exists or is needed.

## The Clay side: webhook to table

Clay is the destination. Every new YC company lands as its own row in a Clay
table, through that table's **Webhook source**.

### Setting it up in Clay

1. Create a new Clay table.
2. **Add source → Webhook.** Clay generates a unique URL for that table.
3. Copy the URL and store it as the Worker secret `CLAY_WEBHOOK_URL` (see
   Setup below). It's a secret, never commit it: anyone holding it can write
   rows into your table.
4. Trigger the first run. Clay creates a column for every field in the
   payload automatically, so there's no mapping step.

### What arrives in each row

The Worker normalises each Algolia hit before sending it, so Clay always gets
the same clean shape no matter how YC's index changes underneath:

```json
{
  "id": "29411",
  "name": "ExampleCo",
  "website": "https://example.com",
  "one_liner": "AI copilot for freight brokers",
  "long_description": "ExampleCo helps brokers quote loads in seconds...",
  "team_size": 4,
  "batch": "Fall 2025",
  "industries": ["B2B", "Supply Chain and Logistics"],
  "regions": ["United States of America", "America / Canada"],
  "stage": "Early",
  "status": "Active",
  "launched_at": "2025-10-02T00:00:00.000Z",
  "yc_profile_url": "https://www.ycombinator.com/companies/exampleco"
}
```

| Field | Why it's there |
|---|---|
| `id` | YC's own object ID. The dedupe key, also stored in KV |
| `name`, `website` | Ready for Clay's company enrichment (domain is the join key) |
| `one_liner`, `long_description` | Input for AI columns: ICP fit, use case, personalisation |
| `team_size`, `stage`, `status` | Quick qualification filters |
| `batch`, `industries`, `regions` | Same facets the Worker filtered on, so the table can be sliced the same way |
| `launched_at` | Converted from a Unix timestamp to ISO 8601 so Clay reads it as a date |
| `yc_profile_url` | Built from the slug, one click back to the source |

### Delivery guarantees

- **One company per webhook call.** Clay's webhook source rejects large
  batched arrays (`413`), so records are never sent as one big array.
- **Throttled.** Three requests at a time with a 300ms pause between batches,
  to stay under Clay's rate limit.
- **Retries on `429` only.** Backoff of 500ms, 1s, 1.5s. A `429` means "slow
  down", so it's worth retrying. Any other error fails straight away.
- **Nothing is marked seen until Clay accepts it.** KV is only updated with
  companies that were actually delivered, so a failed push is retried
  automatically on the next scheduled run. No duplicates, nothing lost.
- **Every run returns a summary**: matching, new, pushed and failed counts, so
  you can check a run without opening Clay.

### From here

Once the rows land, it's a normal Clay table. Enrichment, AI research
columns, contact finding and CRM or sequencer pushes all run off the webhook
rows as they arrive, so new YC companies flow straight into whatever
workflow the table feeds.

## Setup

```bash
npm install
npx wrangler login

# Creates the KV namespace used to remember which companies have been sent.
# Copy the printed id into wrangler.toml's [[kv_namespaces]] block.
npx wrangler kv namespace create YC_SEEN

# Create a Clay table with a Webhook source, then set its URL here:
npx wrangler secret put CLAY_WEBHOOK_URL

# Any string you choose, protects the manual trigger endpoint:
npx wrangler secret put TRIGGER_SECRET

npx wrangler deploy
```

Trigger the first run manually (this is the backfill):

```bash
curl -X POST "https://<your-worker>.workers.dev/run" \
  -H "x-trigger-secret: <your TRIGGER_SECRET>"
```

After that, the Cron Trigger in `wrangler.toml` fires on its own. Nothing
else to do.

## Configuration

Both live in `wrangler.toml`. Edit, then `npx wrangler deploy`.

**Schedule** (`[triggers] crons`, cron syntax, always UTC):

| Cadence | Cron |
|---|---|
| Daily, 9am ET | `0 13 * * *` |
| Mondays + Wednesdays | `0 13 * * 1,3` |
| Fridays only | `0 13 * * 5` |

**Filters** (`[vars]`): `YC_BATCHES`, `YC_INDUSTRIES`, `YC_REGIONS`. Values
must match YC's own facet spelling exactly.

## Debugging a live run

```bash
npx wrangler tail
```

streams real-time logs from the deployed Worker. Easier for iterating on a
fix: run `npx wrangler dev` locally (needs a `.dev.vars` file, gitignored,
with the same secret values as production) and `curl` the local URL, this
prints the full error inline without needing a second terminal pane.

## Known gotchas (already handled in `src/index.js`)

Both were hit and fixed while building this. If you're adapting this code
for a different source/destination, keep both fixes:

- **Clay's webhook rejects large batched payloads (`413`).** Never POST an
  array of many records in one request, send one record per webhook call.
- **Clay's webhook rate-limits fast bursts (`429`).** Requests are sent a
  handful at a time with a short pause between batches, and individual
  `429`s are retried with backoff. A company is only marked "seen" in KV
  once its push actually succeeds, so anything that still fails just gets
  retried automatically on the next scheduled run instead of being lost.

## Extending to other sources

The same pattern (find the real API behind the site, diff against KV, push
new-only through a webhook) applies to other VC/accelerator directories
(Techstars, a16z, etc.), each needs its own investigation first since
none are guaranteed to be Algolia-backed the way YC is. If you're working
in Claude Code, the `scrape-vc-directory-to-clay` skill encodes this whole
process, including both gotchas above, for reuse on the next source.
