#!/usr/bin/env node
/**
 * harvest-buildlist.mjs — BuildList (buildlist.xyz) → discover-ats.mjs company list
 *
 * BuildList is an index of startups "building the future" (AI, robotics, space,
 * defense, bio, energy) — ~830 companies, ~41k open roles. It is NOT a job board
 * in its own right: every "Apply" link on the site points straight at the
 * company's own ATS (Ashby, Greenhouse, Lever, Rippling, ...), which is exactly
 * the surface `scan.mjs` already reads at zero token cost.
 *
 * So BuildList's value here is its COMPANY LIST, not its job feed. Wiring it in
 * as a `job_boards:` provider would mean crawling 1600+ paginated HTML pages to
 * rediscover postings we can already pull from the source ATS — slower, more
 * fragile, and rude. Instead this script harvests the company roster once and
 * resolves each company to its real ATS board. After that the companies are
 * ours: scanning no longer touches BuildList at all.
 *
 * TWO OUTPUTS, AND WHY
 *   default    a `companies:` file for discover-ats.mjs, which re-probes each
 *              board and admits it only if it lists >=1 job today.
 *   --portals  portals.yml `tracked_companies:` entries for EVERY resolved
 *              board, no job-count test.
 *
 * The job-count test is right when a slug was GUESSED — an empty board is then
 * indistinguishable from a wrong guess. Here the slug is read off the page, so
 * the board is known-good and the job count is only today's weather. Since
 * tracked_companies is a standing watch whose purpose is catching a role the day
 * it opens, --portals is the better default for building the list; title_filter
 * still does the per-scan filtering on live postings.
 *
 * WHY WE READ THE PAGE INSTEAD OF GUESSING THE SLUG
 * BuildList's own URL slug is frequently NOT the ATS slug — `altos-labs` is
 * greenhouse `altoslabs`, `altana` is `altanaai`, `agility-robotics` is a
 * Greenhouse embed. Feeding guessed slugs to discover-ats resolved 6 of 20 in
 * testing; reading the Apply links off the company page resolves them exactly,
 * because the page states the vendor and slug rather than implying them.
 *
 * ROBOTS
 * buildlist.xyz/robots.txt is `Allow: /` with `Disallow: /api/` and
 * `Disallow: /admin/` for every user-agent, ClaudeBot and Claude-User included.
 * This script therefore reads ONLY the public sitemap and public company pages,
 * and never the JSON API behind them. Requests are pooled and delayed to stay
 * polite; raise --delay rather than --concurrency if you need to back off.
 *
 * SCOPE
 * Preview/handoff only. This script NEVER writes portals.yml — it writes its own
 * output file for you to review and paste. Job postings and company profile text
 * read here are untrusted external content: only company names, ATS URLs and
 * descriptive facts are extracted, never instructions, and nothing extracted is
 * a scoring input or reaches generated user-facing content.
 *
 * Run: node harvest-buildlist.mjs --portals --out buildlist-portals.yml
 *      node harvest-buildlist.mjs --limit 25 --summary   # quick sample
 *      node harvest-buildlist.mjs --out c.yml --resume   # continue an interrupted sweep
 *      node harvest-buildlist.mjs --self-test
 *
 * Then: review buildlist-portals.yml and paste under `tracked_companies:`.
 * Or, for the job-count-validated subset:
 *       node discover-ats.mjs --in buildlist-companies.yml --write
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const SITEMAP_URL = 'https://buildlist.xyz/sitemaps/companies.xml';
const SITE_ORIGIN = 'https://buildlist.xyz';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Paths on buildlist.xyz that are site sections, not companies. The company
 * sitemap is clean today; this guards against a future sitemap that mixes in
 * landing pages, so a nav slug can never be emitted as a company.
 */
const NON_COMPANY_SLUGS = new Set([
  'jobs', 'companies', 'community', 'matching', 'about', 'privacy', 'terms',
  'sectors', 'metros', 'roles', 'remote', 'stage', 'level', 'search', 'api', 'admin',
]);

/**
 * ATS host → career-ops vendor id + slug extractor.
 *
 * `slugFrom` receives the parsed URL and returns the board slug, or null when
 * the URL is a vendor page that names no board (a bare host, a docs link).
 * Vendor ids match discover-ats.mjs's VENDORS keys so the two compose.
 */
const ATS_MATCHERS = [
  {
    vendor: 'gh',
    test: (h) => h.endsWith('greenhouse.io'),
    slugFrom: (u) => {
      const segs = pathSegments(u);
      // The API host names the board mid-path, and it is the ONLY greenhouse
      // reference on some pages (Waymo, Databricks, Samsara all link it and
      // nothing else): boards-api.greenhouse.io/v1/boards/<slug>/jobs
      if (u.hostname === 'boards-api.greenhouse.io') {
        const i = segs.indexOf('boards');
        return i !== -1 ? segs[i + 1] : null;
      }
      // Embeds name the board in a query param, not the path:
      //   job-boards.greenhouse.io/embed/job_board?for=agilityrobotics
      if (segs[0] === 'embed') return u.searchParams.get('for');
      return segs[0];
    },
  },
  { vendor: 'ashby', test: (h) => h === 'jobs.ashbyhq.com', slugFrom: (u) => pathSegments(u)[0] },
  { vendor: 'lever', test: (h) => h === 'jobs.lever.co', slugFrom: (u) => pathSegments(u)[0] },
  { vendor: 'rippling', test: (h) => h === 'ats.rippling.com', slugFrom: (u) => pathSegments(u)[0] },
  {
    vendor: 'workable',
    test: (h) => h === 'apply.workable.com',
    // apply.workable.com/j/<shortcode> is a per-job short link, not a board.
    // Pages carry one per posting, so by raw count `j` beats the real board
    // slug — it has to be rejected by name, not out-ranked.
    slugFrom: (u) => pathSegments(u)[0],
  },
  {
    vendor: 'smartrecruiters',
    test: (h) => h === 'careers.smartrecruiters.com' || h === 'jobs.smartrecruiters.com',
    slugFrom: (u) => pathSegments(u)[0],
  },
  { vendor: 'join', test: (h) => h === 'join.com', slugFrom: (u) => (pathSegments(u)[0] === 'companies' ? pathSegments(u)[1] : null) },
  { vendor: 'recruitee', test: (h) => h.endsWith('.recruitee.com'), slugFrom: (u) => u.hostname.replace(/\.recruitee\.com$/, '') },
  { vendor: 'breezy', test: (h) => h.endsWith('.breezy.hr'), slugFrom: (u) => u.hostname.replace(/\.breezy\.hr$/, '') },
  { vendor: 'bamboohr', test: (h) => h.endsWith('.bamboohr.com'), slugFrom: (u) => u.hostname.replace(/\.bamboohr\.com$/, '') },
  { vendor: 'pinpoint', test: (h) => h.endsWith('.pinpointhq.com'), slugFrom: (u) => u.hostname.replace(/\.pinpointhq\.com$/, '') },

  // Vendors scan.mjs reads but discover-ats.mjs cannot resolve from a name.
  // They are wired straight into portals.yml instead (see renderPortalsYaml).
  { vendor: 'gem', test: (h) => h === 'jobs.gem.com', slugFrom: (u) => pathSegments(u)[0] },
  // Host-keyed vendors: their provider resolves the tenant from the careers_url
  // host, so the whole hostname travels as the "slug" rather than a bare label.
  { vendor: 'icims', test: (h) => h.endsWith('.icims.com'), slugFrom: (u) => u.hostname, hostKeyed: true },
  { vendor: 'personio', test: (h) => /\.jobs\.personio\.(de|com)$/.test(h), slugFrom: (u) => u.hostname, hostKeyed: true },
  { vendor: 'teamtailor', test: (h) => h.endsWith('.teamtailor.com'), slugFrom: (u) => u.hostname, hostKeyed: true },

  // Hint-only: recognizable, but NOT auto-wirable from what the page exposes.
  // Workday needs a tenant coordinate a slug can't supply; Comeet's provider
  // needs a careers-api URL carrying a secret ?token=, and the branded
  // www.comeet.com/jobs/... link has no token in it. Both are carried through
  // as manual follow-up rather than emitted as entries that would never scan.
  { vendor: 'workday', test: (h) => h.endsWith('.myworkdayjobs.com'), slugFrom: () => null, hintOnly: true },
  { vendor: 'comeet', test: (h) => h === 'www.comeet.com' || h === 'comeet.com' || h === 'www.comeet.co', slugFrom: () => null, hintOnly: true },
];

/** Vendors discover-ats.mjs can resolve from a name/slug. */
const DISCOVER_ATS_VENDORS = new Set([
  'gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'rippling', 'join',
  'recruitee', 'breezy', 'bamboohr', 'pinpoint',
]);

/**
 * Vendor route words that sit where a board slug does. These are rejected by
 * name rather than out-ranked: a company page carries one short link per
 * posting, so the route word can easily outnumber the real board slug.
 */
const VENDOR_ROUTE_WORDS = {
  gh: new Set(['embed', 'job_board', 'jobs']),
  workable: new Set(['j']),
  lever: new Set(['jobs']),
};

/**
 * Non-empty path segments of a URL, kept percent-ENCODED.
 *
 * Ashby genuinely hosts boards whose slug contains a space
 * (`jobs.ashbyhq.com/american%20terawatt` is a live 200). Decoding it would
 * yield a slug that produces a malformed URL everywhere downstream, so the
 * encoded form — which is what a real careers_url looks like — is what travels.
 */
function pathSegments(url) {
  return url.pathname.split('/').map(s => s.trim()).filter(Boolean);
}

const USAGE = `Usage:
  node harvest-buildlist.mjs --out buildlist-companies.yml   # full sweep (~830 pages)
  node harvest-buildlist.mjs --limit 25 --summary            # quick sample, human table
  node harvest-buildlist.mjs --out c.yml --resume            # continue an interrupted sweep
  node harvest-buildlist.mjs --json                          # machine-readable result
  node harvest-buildlist.mjs --self-test                     # inline test suite
  node harvest-buildlist.mjs --help

Options:
  --out <file>        Write the discover-ats.mjs input YAML here (default: stdout)
  --limit <n>         Only harvest the first N companies (testing)
  --concurrency <n>   Parallel page fetches (default ${DEFAULT_CONCURRENCY}); prefer raising --delay over this
  --delay <ms>        Pause between requests in a worker (default ${DEFAULT_DELAY_MS})
  --portals           Emit portals.yml tracked_companies entries instead of a
                      discover-ats input file (admits every resolved board)
  --disabled          With --portals, stage entries as enabled: false
  --include-tracked   With --portals, keep companies portals.yml already tracks
                      (default: they are skipped, so the file is safe to paste)
  --portals-file <f>  portals.yml to dedup against (default: ./portals.yml)
  --resume            Skip companies already present in the --out file's checkpoint
  --summary           Human-readable table instead of YAML
  --json              JSON result instead of YAML

This script NEVER writes portals.yml. It produces an input file for
discover-ats.mjs, which validates each board and needs its own --write.`;

/**
 * Extract company slugs from BuildList's company sitemap XML.
 * Exported for unit tests.
 *
 * @param {string} xml - Raw sitemap body.
 * @returns {string[]} Deduped, sorted company slugs.
 */
export function parseCompanySitemap(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const slugs = new Set();
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    let url;
    try {
      url = new URL(m[1]);
    } catch {
      continue;
    }
    if (url.hostname !== 'buildlist.xyz' && url.hostname !== 'www.buildlist.xyz') continue;
    const segs = pathSegments(url);
    // A company lives at the root: /mercor. Anything deeper is a section page.
    if (segs.length !== 1) continue;
    const slug = segs[0].toLowerCase();
    if (NON_COMPANY_SLUGS.has(slug)) continue;
    slugs.add(slug);
  }
  return [...slugs].sort();
}

/**
 * Unescape the JS/JSON string escaping that Next.js flight payloads apply to
 * embedded URLs, so a href survives as a parseable URL.
 *
 * @param {string} html
 * @returns {string}
 */
function unescapePayload(html) {
  return html
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/');
}

/**
 * Find every ATS board referenced by a BuildList company page.
 *
 * The page's Apply links are authoritative: they state the vendor and the exact
 * board slug, which the BuildList URL slug frequently does not match. Where a
 * page references more than one board (rare — usually a regional Greenhouse
 * mirror) they are all returned, most-referenced first, so the caller can pick.
 *
 * Exported for unit tests.
 *
 * @param {string} html - Raw company page body.
 * @returns {{vendor: string, slug: string|null, url: string, count: number}[]}
 */
export function extractAtsBoards(html) {
  if (typeof html !== 'string' || !html) return [];
  const text = unescapePayload(html);
  /** @type {Map<string, {vendor: string, slug: string|null, url: string, count: number}>} */
  const found = new Map();

  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    let url;
    try {
      url = new URL(m[0]);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

    const host = url.hostname.toLowerCase();
    const matcher = ATS_MATCHERS.find(v => v.test(host));
    if (!matcher) continue;

    let slug = null;
    try {
      slug = matcher.slugFrom(url);
    } catch {
      continue;
    }
    if (slug != null) {
      slug = String(slug).trim().toLowerCase();
      if (!slug) continue;
      if (VENDOR_ROUTE_WORDS[matcher.vendor]?.has(slug)) continue;
    } else if (!matcher.hintOnly) {
      continue;
    }

    // A hint-only vendor has no slug, so it dedups on the tenant portion of the
    // path (Comeet: /jobs/<company>/<uid>) rather than the full posting URL,
    // which would otherwise register every posting as a separate "board".
    const hintUrl = slug ? null : `${url.origin}/${pathSegments(url).slice(0, 3).join('/')}`;
    const key = `${matcher.vendor}:${slug ?? hintUrl}`;
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      found.set(key, {
        vendor: matcher.vendor,
        slug,
        // Keep the board root, not the individual posting URL.
        url: slug ? boardUrl(matcher.vendor, slug) : hintUrl,
        hintOnly: Boolean(matcher.hintOnly),
        count: 1,
      });
    }
  }

  return [...found.values()].sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

/**
 * Canonical board root URL for a vendor + slug. Mirrors discover-ats.mjs's
 * buildUrl shapes so the emitted hint matches what it will probe.
 *
 * @param {string} vendor
 * @param {string} slug
 * @returns {string}
 */
export function boardUrl(vendor, slug) {
  switch (vendor) {
    case 'gh': return `https://job-boards.greenhouse.io/${slug}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${slug}`;
    case 'lever': return `https://jobs.lever.co/${slug}`;
    case 'rippling': return `https://ats.rippling.com/${slug}/jobs`;
    case 'workable': return `https://apply.workable.com/${slug}`;
    case 'smartrecruiters': return `https://careers.smartrecruiters.com/${slug}`;
    case 'join': return `https://join.com/companies/${slug}`;
    case 'recruitee': return `https://${slug}.recruitee.com`;
    case 'breezy': return `https://${slug}.breezy.hr`;
    case 'bamboohr': return `https://${slug}.bamboohr.com`;
    case 'pinpoint': return `https://${slug}.pinpointhq.com`;
    case 'gem': return `https://jobs.gem.com/${slug}`;
    // Host-keyed: `slug` is already the full tenant hostname.
    case 'icims': return `https://${slug}/jobs/search?ss=1`;
    case 'personio': return `https://${slug}`;
    case 'teamtailor': return `https://${slug}`;
    default: return '';
  }
}

/**
 * The `api:` field for a portals.yml entry, where the provider reads a
 * dedicated endpoint rather than deriving one from careers_url. Only Greenhouse
 * takes one in practice — every other provider here resolves from the host or
 * path of careers_url alone.
 *
 * @param {string} vendor
 * @param {string} slug
 * @returns {string|null}
 */
export function apiUrl(vendor, slug) {
  return vendor === 'gh' ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` : null;
}

/**
 * Boilerplate BuildList appends to a company title. Stripped repeatedly, because
 * the two live title shapes stack it differently:
 *   "Altos Labs Careers & Jobs — 15 Open Roles | BuildList"
 *   "Aigen — Company Profile & Careers | BuildList"
 * Anchored to the end and requiring leading whitespace, so a company genuinely
 * named "… Jobs" only loses the suffix if it also reads as boilerplate.
 */
const TITLE_BOILERPLATE = /\s+(?:Company\s+Profile\s*&\s*Careers|Careers\s*&\s*Jobs|Jobs\s*&\s*Careers|Open\s+Roles|Careers|Jobs)$/i;

/**
 * Best-effort human company name for a BuildList slug.
 *
 * Prefers the page's own <title>, which carries real capitalisation and
 * punctuation, and falls back to title-casing the slug. Exported for unit tests.
 *
 * @param {string} html
 * @param {string} slug
 * @returns {string}
 */
export function extractCompanyName(html, slug) {
  const m = typeof html === 'string' ? html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) : null;
  if (m) {
    const raw = m[1]
      .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
      .trim();
    // Drop the "| BuildList" site suffix, then the "— 15 Open Roles" tail.
    const head = raw.split(/\s*[|·]\s*/)[0];
    let name = head.split(/\s+[—–]\s+/)[0].trim();
    let previous;
    do { previous = name; name = name.replace(TITLE_BOILERPLATE, '').trim(); } while (name !== previous);
    if (name && !/^buildlist$/i.test(name)) return name;
  }
  return titleCaseSlug(slug);
}

/**
 * Flatten a page to readable text: BuildList's profile facts sit in markup
 * whose attributes carry digits, so any regex over raw HTML picks up the wrong
 * numbers (this bit the "Open positions" count once already).
 *
 * @param {string} html
 * @returns {string}
 */
export function flattenHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * BuildList's own profile facts for a company — sector, one-line description,
 * HQ, headcount, funding, and the count of roles it lists.
 *
 * These are third-party editorial claims, carried through as descriptive
 * context for a portals.yml `notes:` field only. Nothing here is a scoring
 * input and none of it reaches generated user-facing content.
 *
 * Exported for unit tests.
 *
 * @param {string} html - Raw company page.
 * @param {string} name - Company name, used to anchor the description.
 * @returns {{sector: string, blurb: string, hq: string, employees: string, raised: string, founded: string, openRoles: number|null}}
 */
export function extractProfile(html, name) {
  const txt = flattenHtml(html);
  const grab = (re) => { const m = txt.match(re); return m ? m[1].trim() : ''; };

  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let blurb = grab(new RegExp(esc + '\\s+(.{3,220}?)\\s+Save\\s+Website'));
  if (!blurb) blurb = grab(/Updated\s+\w{3}\s+\d{4}\s+.{0,60}?\s+(.{3,220}?)\s+Save\s+Website/);

  const openM = txt.match(/Open positions\s+([\d,]+)/);

  return {
    sector: grab(/Company profile\s*\/\s*([^/]{2,40}?)\s+Updated\s+\w{3}\s+\d{4}/),
    blurb,
    hq: grab(/\bHQ\s+(.{2,40}?)\s+(?:Founded|Employees|Total Raised|Last Round)\b/),
    employees: grab(/\bEmployees\s+([\d,]+(?:-[\d,]+|\+)?)\s/),
    raised: grab(/\bTotal Raised\s+(\$[\d.]+[BMK]?)\s/),
    founded: grab(/\bFounded\s+(\d{4})\b/),
    openRoles: openM ? Number(openM[1].replace(/,/g, '')) : null,
  };
}

/** Title-case a hyphenated slug: `aalo-atomics` → `Aalo Atomics`. */
export function titleCaseSlug(slug) {
  return String(slug).split('-')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Fetch one URL as text, with a timeout and the shared career-ops UA.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Harvest the BuildList company roster and resolve each company's ATS board.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.delay]
 * @param {string[]} [opts.skip] - Slugs already harvested (--resume).
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {(url: string) => Promise<string>} [opts.fetchImpl] - Injected for tests.
 * @returns {Promise<{resolved: object[], unresolved: object[], errors: object[], total: number}>}
 */
export async function harvest(opts = {}) {
  const {
    limit,
    concurrency = DEFAULT_CONCURRENCY,
    delay = DEFAULT_DELAY_MS,
    skip = [],
    onProgress,
    fetchImpl = fetchText,
  } = opts;

  const sitemapXml = await fetchImpl(SITEMAP_URL);
  let slugs = parseCompanySitemap(sitemapXml);
  const total = slugs.length;

  const skipSet = new Set(skip);
  slugs = slugs.filter(s => !skipSet.has(s));
  if (Number.isFinite(limit) && limit > 0) slugs = slugs.slice(0, limit);

  const resolved = [];
  const hintOnly = [];
  const unresolved = [];
  const errors = [];
  let done = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= slugs.length) return;
      const slug = slugs[i];
      try {
        const html = await fetchImpl(`${SITE_ORIGIN}/${slug}`);
        const name = extractCompanyName(html, slug);
        const profile = extractProfile(html, name);
        const boards = extractAtsBoards(html);
        // A wirable board always beats a hint-only one, however often the
        // hint-only vendor is referenced: a Workday or Comeet link that wins on
        // count would otherwise mask a scannable Greenhouse board on the page.
        const best = boards.find(b => b.slug) || boards[0];
        if (best && best.slug) {
          resolved.push({
            name, buildlistSlug: slug, profile,
            vendor: best.vendor, slug: best.slug, board: best.url,
            alternates: boards.filter(b => b !== best),
          });
        } else if (best) {
          hintOnly.push({ name, buildlistSlug: slug, profile, vendor: best.vendor, board: best.url });
        } else {
          unresolved.push({
            name, buildlistSlug: slug, profile,
            reason: profile.openRoles === 0
              ? 'no open roles listed'
              : 'no recognized ATS link on page (custom careers site, or JS-rendered)',
          });
        }
      } catch (err) {
        errors.push({ buildlistSlug: slug, error: err.message });
      }
      done += 1;
      onProgress?.(done, slugs.length);
      if (delay > 0) await sleep(delay);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, worker));

  const byName = (a, b) => a.name.localeCompare(b.name);
  resolved.sort(byName);
  hintOnly.sort(byName);
  unresolved.sort(byName);
  return { resolved, hintOnly, unresolved, errors, total };
}

/**
 * Render harvested companies as a discover-ats.mjs input file.
 *
 * Workday entries are emitted commented-out: discover-ats can't resolve a
 * Workday board from a slug, so an active entry would only ever be noise.
 *
 * @param {{resolved: object[], unresolved: object[]}} result
 * @returns {string}
 */
export function renderCompaniesYaml(result) {
  const lines = [
    '# Harvested from BuildList (https://buildlist.xyz) by harvest-buildlist.mjs',
    `# ${new Date().toISOString().slice(0, 10)} — ${result.resolved.length} companies with a resolvable ATS board.`,
    '#',
    '# Slugs are read from each company page\'s Apply links, so they are the real',
    '# ATS slugs, not BuildList\'s URL slugs. Feed this to discover-ats.mjs, which',
    '# confirms each board actually lists jobs before proposing a portals.yml entry:',
    '#',
    '#   node discover-ats.mjs --in <this file> --summary',
    '#   node discover-ats.mjs --in <this file> --write',
    '',
    'companies:',
  ];

  for (const c of result.resolved) {
    if (!DISCOVER_ATS_VENDORS.has(c.vendor)) {
      lines.push(`  # - name: ${yamlString(c.name)}   # ${c.vendor} — scannable, but discover-ats can't resolve it; use --portals`);
      continue;
    }
    lines.push(`  - name: ${yamlString(c.name)}`);
    lines.push(`    slug: ${c.slug}`);
    lines.push(`    website: ${c.board}   # ${c.vendor}`);
  }

  if (result.unresolved.length) {
    lines.push('');
    lines.push(`# ${result.unresolved.length} companies had no recognized ATS link on their BuildList page.`);
    for (const c of result.unresolved) lines.push(`#   - ${c.name} (/${c.buildlistSlug}) — ${c.reason}`);
  }

  return lines.join('\n') + '\n';
}


/**
 * Company identities already present in a portals.yml, so a generated paste can
 * never introduce a second entry for a company the user already tracks —
 * portals.yml has no dedup pass, so a duplicate silently double-scans the board.
 *
 * Deliberately a line scan rather than a YAML parse: this only needs `name:`,
 * `careers_url:` and `api:` values, and a line scan cannot throw on a portals.yml
 * that is mid-edit or carries a construct js-yaml rejects.
 *
 * @param {string} portalsPath
 * @returns {{names: Set<string>, boards: Set<string>}}
 */
export function loadTrackedIdentities(portalsPath) {
  const names = new Set();
  const boards = new Set();
  if (!existsSync(portalsPath)) return { names, boards };
  for (const line of readFileSync(portalsPath, 'utf8').split('\n')) {
    const name = line.match(/^\s*-?\s*name:\s*(.+?)\s*$/);
    if (name) { const v = normalizeCompanyKey(name[1]); if (v) names.add(v); }
    const url = line.match(/^\s*(?:careers_url|api):\s*(\S+)\s*$/);
    if (url) { const v = normalizeBoardKey(url[1]); if (v) boards.add(v); }
  }
  return { names, boards };
}

/** Case- and punctuation-insensitive company key: "Altos Labs" === "altos-labs". */
export function normalizeCompanyKey(name) {
  return String(name).replace(/^["']|["']$/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Board identity: host + path, ignoring scheme, query, trailing slash and case. */
export function normalizeBoardKey(url) {
  try {
    const u = new URL(String(url).replace(/^["']|["']$/g, ''));
    return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Split resolved companies into those portals.yml already tracks and those it
 * does not. Matching on EITHER the name or the board catches both spellings of
 * the same company (a renamed entry keeps its board; a re-hosted board keeps
 * its name).
 *
 * @param {object[]} resolved
 * @param {{names: Set<string>, boards: Set<string>}} tracked
 * @returns {{fresh: object[], already: object[]}}
 */
export function partitionAgainstTracked(resolved, tracked) {
  const fresh = [];
  const already = [];
  for (const c of resolved) {
    const hit = tracked.names.has(normalizeCompanyKey(c.name))
      || tracked.boards.has(normalizeBoardKey(c.board));
    (hit ? already : fresh).push(c);
  }
  return { fresh, already };
}

/**
 * Render harvested companies as portals.yml `tracked_companies` entries.
 *
 * WHY THIS EXISTS ALONGSIDE renderCompaniesYaml
 * discover-ats.mjs admits a company only if its board lists ≥1 job right now.
 * That is the right test when you are GUESSING a slug — a board with no jobs is
 * indistinguishable from a wrong guess. Here the slug was read off the page, so
 * the board is known-good, and the job count is just today's weather.
 *
 * Applying a point-in-time test to `tracked_companies` defeats its purpose:
 * the list is a standing watch whose whole job is to catch a role the DAY it
 * opens. A company hiring nothing today is exactly the one worth watching.
 * So this renderer admits every resolved board and lets `title_filter` — which
 * runs per scan, on live postings — do the filtering it is actually for.
 *
 * Entries are grouped by BuildList sector and carry its one-line description,
 * so the file stays readable at ~600 companies. Hint-only vendors and companies
 * with no recognized board are listed as comments for manual follow-up rather
 * than emitted as entries that would fail every scan.
 *
 * @param {{resolved: object[], hintOnly?: object[], unresolved?: object[]}} result
 * @param {{enabled?: boolean, tracked?: {names: Set<string>, boards: Set<string>}}} [opts]
 *   `enabled: false` stages entries without widening the next scan until you
 *   flip them on. `tracked` drops companies portals.yml already carries.
 * @returns {string}
 */
export function renderPortalsYaml(result, opts = {}) {
  const enabled = opts.enabled !== false;
  const today = new Date().toISOString().slice(0, 10);
  const all = result.resolved || [];
  const { fresh: resolved, already } = opts.tracked
    ? partitionAgainstTracked(all, opts.tracked)
    : { fresh: all, already: [] };

  const lines = [
    '# BuildList companies — paste into portals.yml under `tracked_companies:`',
    `# Harvested ${today} by harvest-buildlist.mjs from https://buildlist.xyz`,
    `# ${resolved.length} companies, each resolved to a board scan.mjs can read.`,
    ...(already.length
      ? [`# ${already.length} more were skipped because portals.yml already tracks them.`]
      : []),
    '#',
    '# Admission is NOT conditioned on having a matching role today: tracked_companies',
    '# is a standing watch, and title_filter does the per-scan filtering.',
    '#',
    '# Sector and description are BuildList\'s own editorial text, carried through as',
    '# context only — they are not scoring inputs.',
    '',
  ];

  const bySector = new Map();
  for (const c of resolved) {
    const sector = c.profile?.sector || 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(c);
  }
  const sectors = [...bySector.keys()].sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return bySector.get(b).length - bySector.get(a).length || a.localeCompare(b);
  });

  for (const sector of sectors) {
    const group = bySector.get(sector).slice().sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`  # -- ${sector} (${group.length}) --`);
    lines.push('');
    for (const c of group) {
      lines.push(`  - name: ${yamlString(c.name)}`);
      lines.push(`    careers_url: ${c.board}`);
      const api = apiUrl(c.vendor, c.slug);
      if (api) lines.push(`    api: ${api}`);
      const note = noteFor(c, sector);
      if (note) lines.push(`    notes: ${JSON.stringify(note)}`);
      lines.push(`    enabled: ${enabled}`);
      lines.push('');
    }
  }

  const hints = result.hintOnly || [];
  if (hints.length) {
    lines.push(`  # -- ${hints.length} companies need a manual coordinate --`);
    lines.push('  # Workday needs a tenant/site; Comeet needs a careers-api URL with its');
    lines.push('  # ?token=, which the public page never exposes. Board link is the starting point.');
    for (const c of hints) lines.push(`  #   ${c.name} (${c.vendor}): ${c.board}`);
    lines.push('');
  }

  const un = result.unresolved || [];
  if (un.length) {
    const noRoles = un.filter(c => c.profile?.openRoles === 0).length;
    lines.push(`  # -- ${un.length} companies had no recognized ATS board --`);
    lines.push(`  # ${noRoles} of them list no open roles at all; the rest use a custom careers`);
    lines.push('  # site or an ATS career-ops has no provider for. Re-run later to pick up changes.');
    for (const c of un) lines.push(`  #   ${c.name} (/${c.buildlistSlug}) — ${c.reason}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * One-line `notes:` value: what the company does, plus the facts that help
 * judge it later. Kept to a single line — portals.yml notes are scanned, not read.
 *
 * @param {object} c - Resolved company.
 * @param {string} sector
 * @returns {string}
 */
function noteFor(c, sector) {
  const p = c.profile || {};
  const head = [sector, p.blurb].filter(Boolean).join('. ');
  const facts = [p.hq, p.employees && `${p.employees} staff`, p.raised && `${p.raised} raised`]
    .filter(Boolean).join(', ');
  const tail = `via BuildList ${new Date().toISOString().slice(0, 10)}`;
  return [head, facts, tail].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
}

/** Quote a YAML scalar only when it needs it. */
function yamlString(s) {
  return /^[A-Za-z0-9][A-Za-z0-9 ._&'()+-]*$/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s);
}

/**
 * Human-readable summary table.
 *
 * @param {{resolved: object[], unresolved: object[], errors: object[], total: number}} result
 * @returns {string}
 */
export function renderSummary(result) {
  const byVendor = new Map();
  for (const c of result.resolved) byVendor.set(c.vendor, (byVendor.get(c.vendor) || 0) + 1);

  const out = [
    '='.repeat(78),
    '  BuildList harvest — career-ops',
    `  resolved: ${result.resolved.length} | manual coordinate: ${(result.hintOnly || []).length} | no board: ${result.unresolved.length} | errors: ${result.errors.length} | roster: ${result.total}`,
    '='.repeat(78),
    '',
    '  Boards by vendor:',
  ];
  for (const [vendor, n] of [...byVendor.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`    ${vendor.padEnd(18)} ${n}`);
  }
  const bySector = new Map();
  for (const c of result.resolved) {
    const k = c.profile?.sector || 'Other';
    bySector.set(k, (bySector.get(k) || 0) + 1);
  }
  if (bySector.size) {
    out.push('');
    out.push('  Companies by sector:');
    for (const [sector, n] of [...bySector.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`    ${sector.padEnd(28)} ${n}`);
    }
  }
  out.push('');
  out.push('  Company                              Vendor      Board');
  out.push('  ' + '-'.repeat(88));
  for (const c of result.resolved.slice(0, 40)) {
    out.push(`  ${truncate(c.name, 36).padEnd(37)}${c.vendor.padEnd(12)}${c.board}`);
  }
  if (result.resolved.length > 40) out.push(`  ... and ${result.resolved.length - 40} more`);
  if (result.errors.length) {
    out.push('');
    out.push('  Errors:');
    for (const e of result.errors.slice(0, 10)) out.push(`    - ${e.buildlistSlug}: ${e.error}`);
  }
  return out.join('\n');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Checkpoint path for a given --out file, so --resume can continue a sweep. */
function checkpointPath(outFile) {
  return `${outFile}.progress.json`;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/** @returns {number} failing assertion count */
export function selfTest() {
  let failed = 0;
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { console.error(`  ✗ ${label}\n      expected ${e}\n      actual   ${a}`); failed += 1; }
    else console.log(`  ✓ ${label}`);
  };

  eq('sitemap: extracts root-level company slugs', parseCompanySitemap(
    '<urlset><url><loc>https://buildlist.xyz/mercor</loc></url>' +
    '<url><loc>https://buildlist.xyz/aalo-atomics</loc></url></urlset>'),
    ['aalo-atomics', 'mercor']);

  eq('sitemap: drops section pages and deep paths', parseCompanySitemap(
    '<urlset><url><loc>https://buildlist.xyz/jobs</loc></url>' +
    '<url><loc>https://buildlist.xyz/jobs/openings/foo</loc></url>' +
    '<url><loc>https://buildlist.xyz/mercor</loc></url></urlset>'),
    ['mercor']);

  eq('sitemap: ignores foreign hosts', parseCompanySitemap(
    '<urlset><url><loc>https://evil.example/mercor</loc></url></urlset>'), []);

  eq('boards: reads ashby slug from an apply link', extractAtsBoards(
    '<a href="https://jobs.ashbyhq.com/mercor/3ecb8ca3?utm_source=buildlist">Apply</a>'),
    [{ vendor: 'ashby', slug: 'mercor', url: 'https://jobs.ashbyhq.com/mercor', hintOnly: false, count: 1 }]);

  eq('boards: reads greenhouse embed ?for= slug', extractAtsBoards(
    '<iframe src="https://job-boards.greenhouse.io/embed/job_board?for=agilityrobotics"></iframe>'),
    [{ vendor: 'gh', slug: 'agilityrobotics', url: 'https://job-boards.greenhouse.io/agilityrobotics', hintOnly: false, count: 1 }]);

  eq('boards: unescapes flight-payload URLs', extractAtsBoards(
    '{"href":"https:\\u002F\\u002Fjob-boards.greenhouse.io\\u002Faltoslabs\\u002F1234"}'),
    [{ vendor: 'gh', slug: 'altoslabs', url: 'https://job-boards.greenhouse.io/altoslabs', hintOnly: false, count: 1 }]);

  eq('boards: dedups and ranks by reference count', extractAtsBoards(
    'https://jobs.lever.co/acme/1 https://jobs.lever.co/acme/2 https://jobs.ashbyhq.com/other/9'),
    [
      { vendor: 'lever', slug: 'acme', url: 'https://jobs.lever.co/acme', hintOnly: false, count: 2 },
      { vendor: 'ashby', slug: 'other', url: 'https://jobs.ashbyhq.com/other', hintOnly: false, count: 1 },
    ]);

  eq('boards: subdomain vendors take the slug from the host', extractAtsBoards(
    'https://acmecorp.recruitee.com/o/engineer'),
    [{ vendor: 'recruitee', slug: 'acmecorp', url: 'https://acmecorp.recruitee.com', hintOnly: false, count: 1 }]);

  eq('boards: bare embed with no ?for= is not a board', extractAtsBoards(
    'https://job-boards.greenhouse.io/embed'), []);

  // Regression: the real board appeared twice, the /j/ short link four times,
  // so count-ranking alone elected `j` as the slug for 8 companies.
  eq('boards: workable /j/ short links never beat the real board', extractAtsBoards(
    'https://apply.workable.com/j/1318B10262 https://apply.workable.com/j/8D34CAB720 ' +
    'https://apply.workable.com/j/F08AA0CBF9 https://apply.workable.com/j/F2BCFF40F7 ' +
    'https://apply.workable.com/anthro/'),
    [{ vendor: 'workable', slug: 'anthro', url: 'https://apply.workable.com/anthro', hintOnly: false, count: 1 }]);

  // jobs.ashbyhq.com/american%20terawatt is a live 200; decoding the space
  // would produce a malformed URL in every downstream consumer.
  // Waymo, Databricks and Samsara link ONLY the Greenhouse API host; matching
  // just job-boards/boards hosts scored all three as "no ATS link" (2,571 open
  // roles across 26 companies were lost to this).
  eq('boards: reads the slug out of the greenhouse API url', extractAtsBoards(
    'https://boards-api.greenhouse.io/v1/boards/waymo/jobs'),
    [{ vendor: 'gh', slug: 'waymo', url: 'https://job-boards.greenhouse.io/waymo', hintOnly: false, hintOnly: false, count: 1 }]);

  eq('boards: gem board id comes from the path', extractAtsBoards(
    'https://jobs.gem.com/astroforge-io/T2F0c0pvYlBvc3Q6MTM3MTg5Mw%3D%3D'),
    [{ vendor: 'gem', slug: 'astroforge-io', url: 'https://jobs.gem.com/astroforge-io', hintOnly: false, count: 1 }]);

  // Host-keyed vendors: the provider resolves the tenant from the careers_url
  // host, so the hostname is what has to survive, not a bare label.
  eq('boards: icims keeps the tenant host', extractAtsBoards(
    'https://careers-jobyaviation.icims.com/jobs/4312/core-software-services-lead/job')
    .map(b => [b.vendor, b.url]),
    [['icims', 'https://careers-jobyaviation.icims.com/jobs/search?ss=1']]);

  eq('boards: personio keeps the tenant host', extractAtsBoards(
    'https://stark.jobs.personio.com/job/2315143').map(b => [b.vendor, b.url]),
    [['personio', 'https://stark.jobs.personio.com']]);

  eq('boards: teamtailor keeps the tenant host', extractAtsBoards(
    'https://acme.teamtailor.com/jobs/12-engineer').map(b => [b.vendor, b.url]),
    [['teamtailor', 'https://acme.teamtailor.com']]);

  // Comeet's provider needs a careers-api URL carrying a secret ?token=, which
  // the public page never exposes — so it is a hint, never an entry.
  eq('boards: comeet is hint-only and dedups on the tenant, not the posting', extractAtsBoards(
    'https://www.comeet.com/jobs/covenantindustries/3B.00F/comms-engineer/94.F6D ' +
    'https://www.comeet.com/jobs/covenantindustries/3B.00F/contracts/A4.F60'),
    [{ vendor: 'comeet', slug: null, url: 'https://www.comeet.com/jobs/covenantindustries/3B.00F', hintOnly: true, count: 2 }]);

  eq('api: only greenhouse gets an api: field',
    [apiUrl('gh', 'waymo'), apiUrl('ashby', 'mercor'), apiUrl('gem', 'x')],
    ['https://boards-api.greenhouse.io/v1/boards/waymo/jobs', null, null]);

  eq('profile: reads sector, blurb and facts off the page',
    (function () {
      const p = extractProfile(
        '<div>Company profile / Energy &amp; Climate Updated Sep 2026 Crusoe Energy ' +
        'Builds AI-scale data centers. Save Website Careers LinkedIn Open positions 373 ' +
        'Roles HQ Denver, CO Founded 2018 Employees 1,001-5,000 Total Raised $14.8B Last Round</div>',
        'Crusoe Energy');
      return [p.sector, p.blurb, p.hq, p.employees, p.raised, p.founded, p.openRoles];
    })(),
    ['Energy & Climate', 'Builds AI-scale data centers.', 'Denver, CO', '1,001-5,000', '$14.8B', '2018', 373]);

  // Regression: "Open positions" and its number are separated by markup whose
  // attributes contain digits, so a raw-HTML regex read the wrong number.
  eq('profile: open-role count survives intervening markup',
    extractProfile('<p class="x2">Open positions</p><span data-n="7">343</span> Roles', 'Waymo').openRoles,
    343);

  var portals = renderPortalsYaml({
    resolved: [
      { name: 'Waymo', vendor: 'gh', slug: 'waymo', board: 'https://job-boards.greenhouse.io/waymo',
        profile: { sector: 'Transportation', blurb: 'Operates autonomous vehicles.', hq: 'Mountain View, CA', employees: '5,001+', raised: '$13.5B', openRoles: 343 } },
    ],
    hintOnly: [{ name: 'Covenant', vendor: 'comeet', board: 'https://www.comeet.com/jobs/covenantindustries/3B.00F' }],
    unresolved: [{ name: 'Meta', buildlistSlug: 'meta', reason: 'custom careers site', profile: { openRoles: 955 } }],
  });
  eq('portals: emits careers_url + api + notes + enabled',
    portals.includes('  - name: Waymo') &&
    portals.includes('    careers_url: https://job-boards.greenhouse.io/waymo') &&
    portals.includes('    api: https://boards-api.greenhouse.io/v1/boards/waymo/jobs') &&
    portals.includes('    enabled: true') &&
    /notes: ".*Operates autonomous vehicles.*Mountain View, CA.*"/.test(portals), true);

  eq('tracked: name key ignores case and punctuation',
    [normalizeCompanyKey('Altos Labs'), normalizeCompanyKey('altos-labs'), normalizeCompanyKey('"1x"')],
    ['altoslabs', 'altoslabs', '1x']);

  eq('tracked: board key ignores scheme, query and trailing slash',
    [normalizeBoardKey('https://job-boards.greenhouse.io/waymo/'),
     normalizeBoardKey('http://job-boards.greenhouse.io/waymo?utm=x')],
    ['job-boards.greenhouse.io/waymo', 'job-boards.greenhouse.io/waymo']);

  // Either signal alone is enough: a renamed entry keeps its board, and a
  // re-hosted board keeps its name.
  eq('tracked: partition matches on name OR board', (function () {
    const tracked = { names: new Set(['anthropic']), boards: new Set(['jobs.ashbyhq.com/mercor']) };
    const r = partitionAgainstTracked([
      { name: 'Anthropic', board: 'https://job-boards.greenhouse.io/anthropic' },
      { name: 'Mercor Labs', board: 'https://jobs.ashbyhq.com/mercor' },
      { name: 'Brand New', board: 'https://jobs.ashbyhq.com/brandnew' },
    ], tracked);
    return [r.fresh.map(c => c.name), r.already.map(c => c.name)];
  })(), [['Brand New'], ['Anthropic', 'Mercor Labs']]);

  eq('portals: excludes already-tracked companies and says so', (function () {
    const out = renderPortalsYaml({
      resolved: [
        { name: 'Anthropic', vendor: 'gh', slug: 'anthropic', board: 'https://job-boards.greenhouse.io/anthropic', profile: {} },
        { name: 'Brand New', vendor: 'ashby', slug: 'brandnew', board: 'https://jobs.ashbyhq.com/brandnew', profile: {} },
      ],
    }, { tracked: { names: new Set(['anthropic']), boards: new Set() } });
    return [out.includes('- name: Brand New'), out.includes('- name: Anthropic'),
            out.includes('# 1 more were skipped because portals.yml already tracks them.')];
  })(), [true, false, true]);

  eq('portals: groups under a sector heading', portals.includes('  # -- Transportation (1) --'), true);
  eq('portals: hint-only and unresolved stay comments, never entries',
    portals.includes('  #   Covenant (comeet):') && portals.includes('  #   Meta (/meta)') &&
    !portals.includes('- name: Covenant') && !portals.includes('- name: Meta'), true);

  eq('portals: --disabled stages entries without widening the scan',
    renderPortalsYaml({ resolved: [{ name: 'X', vendor: 'ashby', slug: 'x', board: 'https://jobs.ashbyhq.com/x', profile: {} }] },
      { enabled: false }).includes('    enabled: false'), true);

  eq('boards: ashby slugs keep their percent-encoding', extractAtsBoards(
    'https://jobs.ashbyhq.com/american%20terawatt/abc-123'),
    [{ vendor: 'ashby', slug: 'american%20terawatt', url: 'https://jobs.ashbyhq.com/american%20terawatt', hintOnly: false, count: 1 }]);

  eq('boards: non-ATS links are ignored', extractAtsBoards(
    '<a href="https://x.com/buildlistxyz">Follow</a>'), []);

  eq('boards: workday is kept as a URL hint with no slug', extractAtsBoards(
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123').map(b => [b.vendor, b.slug]),
    [['workday', null]]);

  eq('name: prefers the page title over the slug',
    extractCompanyName('<title>Altos Labs — Jobs &amp; Company Profile | BuildList</title>', 'altos-labs'),
    'Altos Labs');

  eq('name: strips the "Careers & Jobs — N Open Roles" tail',
    extractCompanyName('<title>Altos Labs Careers &amp; Jobs — 15 Open Roles | BuildList</title>', 'altos-labs'),
    'Altos Labs');

  eq('name: strips the "— Company Profile & Careers" tail',
    extractCompanyName('<title>Aigen — Company Profile &amp; Careers | BuildList</title>', 'aigen'),
    'Aigen');

  eq('name: keeps a hyphenated company name intact',
    extractCompanyName('<title>Hugging-Face Careers &amp; Jobs | BuildList</title>', 'hugging-face'),
    'Hugging-Face');

  eq('name: falls back to title-casing the slug',
    extractCompanyName('<html>no title</html>', 'aalo-atomics'), 'Aalo Atomics');

  eq('name: ignores a bare BuildList title',
    extractCompanyName('<title>BuildList</title>', 'nine-mothers'), 'Nine Mothers');

  eq('yaml: quotes names that need it', yamlString('1x'), '1x');
  eq('yaml: quotes names with colons', yamlString('Acme: The Sequel'), '"Acme: The Sequel"');

  const rendered = renderCompaniesYaml({
    resolved: [{ name: 'Altos Labs', vendor: 'gh', slug: 'altoslabs', board: 'https://job-boards.greenhouse.io/altoslabs' }],
    unresolved: [],
  });
  eq('yaml: emits a discover-ats companies list',
    rendered.includes('  - name: Altos Labs') && rendered.includes('    slug: altoslabs'), true);

  const wd = renderCompaniesYaml({
    resolved: [{ name: 'Acme', vendor: 'workday', slug: null, board: 'https://acme.wd1.myworkdayjobs.com/careers' }],
    unresolved: [],
  });
  eq('yaml: comments out unresolvable Workday entries', wd.includes('  # - name: Acme'), true);

  console.log(failed === 0 ? '\nAll harvest-buildlist self-tests passed.' : `\n${failed} assertion(s) failed.`);
  return failed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  if (flag('--help') || flag('-h')) { console.log(USAGE); return 0; }
  if (flag('--self-test')) return selfTest() === 0 ? 0 : 1;

  const outFile = value('--out', null) ? resolve(ROOT, value('--out', '')) : null;
  const limit = Number(value('--limit', NaN));
  const concurrency = Number(value('--concurrency', DEFAULT_CONCURRENCY));
  const delay = Number(value('--delay', DEFAULT_DELAY_MS));
  const wantResume = flag('--resume');

  let skip = [];
  let carried = { resolved: [], unresolved: [], errors: [] };
  if (wantResume && outFile && existsSync(checkpointPath(outFile))) {
    try {
      carried = JSON.parse(readFileSync(checkpointPath(outFile), 'utf8'));
      skip = [
        ...carried.resolved.map(c => c.buildlistSlug),
        ...carried.unresolved.map(c => c.buildlistSlug),
      ].filter(Boolean);
      console.error(`Resuming: ${skip.length} companies already harvested.`);
    } catch (err) {
      console.error(`⚠️  checkpoint unreadable, starting fresh — ${err.message}`);
    }
  }

  const isTty = process.stderr.isTTY;
  const result = await harvest({
    limit: Number.isFinite(limit) ? limit : undefined,
    concurrency,
    delay,
    skip,
    onProgress: (done, totalToDo) => {
      if (isTty && (done % 10 === 0 || done === totalToDo)) {
        process.stderr.write(`\r  harvesting… ${done}/${totalToDo}`);
      }
    },
  });
  if (isTty) process.stderr.write('\n');

  // Fold in anything carried over from an interrupted sweep.
  result.resolved = [...carried.resolved, ...result.resolved].sort((a, b) => a.name.localeCompare(b.name));
  result.unresolved = [...carried.unresolved, ...result.unresolved].sort((a, b) => a.name.localeCompare(b.name));
  result.hintOnly = [...(carried.hintOnly || []), ...(result.hintOnly || [])]
    .sort((a, b) => a.name.localeCompare(b.name));
  result.errors = [...(carried.errors || []), ...result.errors];

  if (flag('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (flag('--summary')) {
    console.log(renderSummary(result));
  } else if (flag('--portals')) {
    // Default ON: a duplicate tracked_companies entry silently double-scans a
    // board, and this file exists to be pasted straight into portals.yml.
    const portalsPath = resolve(ROOT, value('--portals-file', 'portals.yml'));
    const tracked = flag('--include-tracked') ? null : loadTrackedIdentities(portalsPath);
    const yaml = renderPortalsYaml(result, { enabled: !flag('--disabled'), tracked });
    if (outFile) {
      writeFileSync(outFile, yaml);
      console.error(renderSummary(result));
      console.error(`\nWrote ${result.resolved.length} portals.yml entries → ${outFile}`);
      console.error('Review, then paste under `tracked_companies:` in portals.yml.');
    } else {
      console.log(yaml);
    }
  } else {
    const yaml = renderCompaniesYaml(result);
    if (outFile) {
      writeFileSync(outFile, yaml);
      console.error(renderSummary(result));
      console.error(`\nWrote ${result.resolved.length} companies → ${outFile}`);
      console.error(`Next: node discover-ats.mjs --in ${value('--out', '')} --summary`);
    } else {
      console.log(yaml);
    }
  }

  if (outFile) {
    // Checkpoint so an interrupted or rate-limited sweep can --resume.
    writeFileSync(checkpointPath(outFile), JSON.stringify(result));
    if (result.errors.length === 0) {
      try { unlinkSync(checkpointPath(outFile)); } catch { /* already gone */ }
    }
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => { console.error(`harvest-buildlist: ${err.message}`); process.exit(1); });
}
