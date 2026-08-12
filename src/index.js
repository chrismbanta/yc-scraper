// Queries YC's own public Algolia search index directly (the same one their
// directory page uses), diffs results against previously-seen company IDs in
// KV, and pushes only genuinely new companies to a Clay webhook source.
//
// First run ever: KV starts empty, so everything currently matching the
// filters counts as "new" and gets pushed (this doubles as the backfill).
// Every run after that only pushes companies that weren't there last time.

const ALGOLIA_APP_ID = "45BWZJ1SGC";
const ALGOLIA_API_KEY =
  "NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE";
const ALGOLIA_INDEX = "YCCompany_production";
const KV_SEEN_KEY = "seen_object_ids";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      const providedSecret = request.headers.get("x-trigger-secret");
      if (!env.TRIGGER_SECRET || providedSecret !== env.TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const summary = await syncYC(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      "YC directory sync worker.\nPOST /run with header x-trigger-secret to trigger manually.\nScheduled runs happen automatically per wrangler.toml's cron.",
      { status: 200 }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncYC(env));
  },
};

async function fetchAllYCHits(env) {
  const facetFilters = [
    env.YC_BATCHES.map((b) => `batch:${b}`),
    env.YC_INDUSTRIES.map((i) => `industries:${i}`),
    env.YC_REGIONS.map((r) => `regions:${r}`),
  ];

  let page = 0;
  let nbPages = 1;
  let allHits = [];

  while (page < nbPages) {
    const res = await fetch(
      `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`,
      {
        method: "POST",
        headers: {
          "X-Algolia-Application-Id": ALGOLIA_APP_ID,
          "X-Algolia-API-Key": ALGOLIA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          params: `query=&hitsPerPage=1000&page=${page}&facetFilters=${encodeURIComponent(
            JSON.stringify(facetFilters)
          )}`,
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`Algolia request failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    allHits = allHits.concat(data.hits);
    nbPages = data.nbPages;
    page += 1;
  }

  return allHits;
}

function normalizeHit(hit) {
  return {
    id: hit.objectID,
    name: hit.name,
    website: hit.website,
    one_liner: hit.one_liner,
    long_description: hit.long_description,
    team_size: hit.team_size,
    batch: hit.batch,
    industries: hit.industries,
    regions: hit.regions,
    stage: hit.stage,
    status: hit.status,
    launched_at: hit.launched_at ? new Date(hit.launched_at * 1000).toISOString() : null,
    yc_profile_url: hit.slug ? `https://www.ycombinator.com/companies/${hit.slug}` : null,
  };
}

const WEBHOOK_CONCURRENCY = 3;
const CHUNK_DELAY_MS = 300;
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends one company to Clay's webhook, retrying with backoff specifically on
// 429 (Clay's webhook rate limit) since that's a "slow down," not a real
// failure. Other error codes fail immediately, no point retrying those.
async function pushToClay(env, hit) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(env.CLAY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizeHit(hit)),
    });

    if (res.ok) return true;

    const body = await res.text();
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(500 * attempt); // 500ms, 1000ms, 1500ms
      continue;
    }

    console.error(`Push failed for ${hit.objectID} (${hit.name}): ${res.status} ${body}`);
    return false;
  }
  return false;
}

// Sends one company per webhook call (Clay's webhook source rejects large
// batched arrays with a 413), a few at a time with a short pause between
// batches to stay under Clay's rate limit. Only IDs that were actually
// delivered get remembered, so anything that still fails after retries gets
// picked up automatically on the next scheduled run.
async function pushAllToClay(env, newHits) {
  const delivered = [];
  for (let i = 0; i < newHits.length; i += WEBHOOK_CONCURRENCY) {
    const chunk = newHits.slice(i, i + WEBHOOK_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (hit) => ({ hit, ok: await pushToClay(env, hit) }))
    );
    for (const { hit, ok } of results) {
      if (ok) delivered.push(hit);
    }
    if (i + WEBHOOK_CONCURRENCY < newHits.length) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
  return delivered;
}

async function syncYC(env) {
  const hits = await fetchAllYCHits(env);

  const seenRaw = await env.YC_SEEN.get(KV_SEEN_KEY);
  const seenIds = new Set(seenRaw ? JSON.parse(seenRaw) : []);

  const newHits = hits.filter((hit) => !seenIds.has(hit.objectID));

  let delivered = [];
  if (newHits.length > 0) {
    if (!env.CLAY_WEBHOOK_URL) {
      throw new Error("CLAY_WEBHOOK_URL secret is not set. Run: npx wrangler secret put CLAY_WEBHOOK_URL");
    }
    delivered = await pushAllToClay(env, newHits);
  }

  delivered.forEach((hit) => seenIds.add(hit.objectID));
  await env.YC_SEEN.put(KV_SEEN_KEY, JSON.stringify([...seenIds]));

  const summary = {
    totalMatchingFilters: hits.length,
    newCompaniesFound: newHits.length,
    newCompaniesPushed: delivered.length,
    newCompaniesFailed: newHits.length - delivered.length,
    runAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(summary));
  return summary;
}
