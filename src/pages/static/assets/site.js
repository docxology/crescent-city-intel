// The Quadruplicate — shared page helpers (authored source, content-hashed at export).
// Every exported page loads this file before its own inline page script.
// §6.1: this prelude was previously duplicated verbatim in 7 inline scripts.
'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const href = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "#";
const date = value => { const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "not recorded"; };
const status = value => `<span class="status ${esc(value)}">${esc(String(value || "unknown").toUpperCase())}</span>`;
const empty = message => `<div class="empty-state">${esc(message)}</div>`;
const FETCH_TIMEOUT_MS = 15000;
async function load(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(path, { cache:"default", signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`could not load ${path} within ${FETCH_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// §6.2 canonical render helpers — one implementation each, replacing the six
// drifted per-page copies (itemCard, event rendering, alert banner, analytics
// signals, health rendering, code search). The most-correct copy of each was
// chosen per the audit §6.2 table: index itemCard (incl. fetchedAt, link guard),
// gui esc() alert banner, gui optional-chained analytics, index calendar cards
// with civic-timezone day hints, sources-with-provenance health.
const EVENT_KIND_LABELS = { "government-meeting": "Government meeting", "community-listing": "Community listing", "civic-news": "Civic news", youtube: "YouTube", "holiday-closure": "Holiday closure" };
const CIVIC_TZ = "America/Los_Angeles";
const SEARCH_CAP = 30;
const debounce = (fn, wait = 200) => { let timer = null; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; };
const matchesFields = (item, fields, needle) => fields.some(field => String(item[field] ?? "").toLowerCase().includes(needle));

function itemCard(item, kind) {
  const title = esc(item.title || item.videoId || "Untitled");
  const link = href(item.link);
  const source = esc(item.source || item.channel || kind || "news");
  const detail = esc(item.description || item.content || item.summary || "");
  const when = item.pubDate || item.date || item.uploadDate || item.curatedAt || item.fetchedAt;
  const tags = Array.isArray(item.tags) ? item.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join("") : "";
  // §2.7: only wrap the title in an anchor when a real http(s) link exists.
  const heading = /^https?:\/\//i.test(String(item.link || "")) ? `<a href="${esc(link)}" rel="noopener noreferrer">${title}</a>` : title;
  return `<article class="item"><h3>${heading}</h3><div class="meta">${source}${when ? ` · ${esc(date(when))}` : ""}</div>${detail ? `<p>${detail}</p>` : ""}${tags}</article>`;
}

function eventStatusChip(eventStatus) {
  const label = String(eventStatus || "unknown").toUpperCase();
  if (eventStatus === "scheduled") return `<span class="pill" style="border-color:var(--cc);color:var(--cc);font-weight:700">${label}</span>`;
  if (eventStatus === "completed") return `<span class="pill" style="opacity:0.75">${label}</span>`;
  return `<span class="pill">${esc(label)}</span>`;
}

function civicDayStamp(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CIVIC_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(parsed));
  const get = kind => Number(parts.find(part => part.type === kind)?.value);
  const year = get("year"), month = get("month"), day = get("day");
  if (!year || !month || !day) return null;
  return year * 10000 + month * 100 + day;
}

function daysUntilHint(dateStart, eventStatus) {
  if (!dateStart || eventStatus === "completed") return "";
  const dateText = String(dateStart).trim().replace(/Z$/, "");
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : dateText.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return "";
  const target = civicDayStamp(`${dateOnly}T12:00:00Z`);
  const today = civicDayStamp(new Date().toISOString());
  if (target === null || today === null) return "";
  const days = target - today;
  if (days === 0) return " · today";
  if (days === 1) return " · tomorrow";
  if (days > 1 && days <= 30) return ` · in ${days} days`;
  return "";
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function eventMonthKey(event) {
  const value = event.dateStart || "undated";
  const match = String(value).match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return { key: `${match[1]}-${match[2]}`, label: `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` };
}

/** Calendar event list item (canonical: index.html copy with status chip, day hint, LLM summary, provenance links). */
function calendarEventCard(event, summaries) {
  const kindLabel = esc(EVENT_KIND_LABELS[event.kind] || event.kind || "event");
  const when = esc(event.dateStart || "date not recorded");
  const timeEl = event.dateStart ? `<time datetime="${esc(event.dateStart)}">${when}</time>` : when;
  const hint = daysUntilHint(event.dateStart, event.status);
  const entry = summaries && typeof summaries === "object" && typeof event.id === "string" ? summaries[event.id] : null;
  const summary = entry && typeof entry === "object" && entry.text ? entry : null;
  const links = (Array.isArray(event.sourceLinks) ? event.sourceLinks : []).filter(link => /^https?:\/\//i.test(String(link))).slice(0, 8);
  const primaryLink = /^https?:\/\//i.test(String(links[0] || "")) ? links[0] : null;
  const titleHtml = primaryLink ? `<h3><a href="${esc(href(primaryLink))}" rel="noopener noreferrer">${esc(event.title)}</a></h3>` : `<h3>${esc(event.title)}</h3>`;
  const locationHtml = event.location ? (primaryLink ? `📍 <a href="${esc(href(primaryLink))}" rel="noopener noreferrer">${esc(event.location)}</a>` : `📍 ${esc(event.location)}`) : "";
  const placeHtml = [locationHtml, event.organizer ? esc(event.organizer) : ""].filter(Boolean).join(" · ");
  const summaryHtml = summary ? `<p><strong>LLM summary — verify against the linked source.</strong> ${esc(summary.text)}</p><div class="meta">${esc(summary.provider)}${summary.model ? `/${esc(summary.model)}` : ""} · generated ${esc(date(summary.generatedAt))}</div>` : "";
  const linksHtml = links.length ? `<div class="meta">Sources: ${links.map((link, index) => `<a href="${esc(href(link))}" rel="noopener noreferrer">[${index + 1}]</a>`).join(" ")}</div>` : "";
  return `<li class="item cal-entry"><div class="cal-when"><div class="meta">${kindLabel}</div>${timeEl ? `<span class="cal-time">${timeEl}</span>` : ""}</div>${titleHtml}<div class="meta">${hint}</div><div>${eventStatusChip(event.status)}</div>${placeHtml ? `<div class="meta">${placeHtml}</div>` : ""}${summaryHtml}${linksHtml}</li>`;
}

/** Group events by month (dateline headers; undated land in a trailing group). Returns [{label, items}]. */
function calendarMonthGroups(events) {
  const groups = new Map();
  for (const event of events) {
    const month = eventMonthKey(event);
    const key = month ? month.key : "undated";
    if (!groups.has(key)) groups.set(key, { label: month ? month.label : "Date not recorded", items: [] });
    groups.get(key).items.push(event);
  }
  return [...groups.values()];
}

/** Alert banner html — esc() throughout (the gui.html copy; §0.1). */
function alertBannerHtml(composite) {
  return composite ? `<div class="banner ${esc(String(composite.level || "").toLowerCase())}"><strong>${esc(composite.level || "UNKNOWN")}</strong> — ${esc(composite.reason || "Composite assessment recorded")}<div class="meta">Assessed ${esc(date(composite.assessedAt))}${composite.hasUnavailableMonitors ? " · one or more monitors unavailable" : ""}</div></div>` : empty("No composite alert snapshot was available.");
}

/** "Signals to watch" list html — esc() throughout (the gui.html copy). */
function analyticsSignalsHtml(overview, limit = 6) {
  const signals = Array.isArray(overview && overview.signals) ? overview.signals.slice(0, limit) : [];
  return signals.length ? `<ul>${signals.map(signal => `<li><strong>${esc(signal.title)}</strong> — ${esc(signal.detail)} <span class="pill">Next: ${esc(signal.nextStep)}</span></li>`).join("")}</ul>` : `<div class="meta">No warning signals were recorded in this edition. Empty feeds remain distinct from unavailable feeds.</div>`;
}

/** Source-health card html — the sources.html copy extended with fetchedAt/ageMs/provenance (the index.html copy). */
function healthCardHtml(source) {
  return `<article class="source ${esc(source.status)}"><h3>${esc(source.source)}</h3><div>${status(source.status)} · ${esc(source.itemCount)} item(s)</div><div class="meta">Checked ${esc(date(source.checkedAt))}${source.fetchedAt ? ` · fetched ${esc(date(source.fetchedAt))}` : ""}${source.ageMs != null ? ` · age ${esc(Math.round(source.ageMs / 3600000))}h` : ""}</div>${source.provenance ? `<div class="meta">${esc(source.provenance)}</div>` : ""}${source.url ? `<div><a href="${esc(href(source.url))}" rel="noopener noreferrer">source</a></div>` : ""}${source.error ? `<div class="error">${esc(source.error)}</div>` : ""}</article>`;
}

/** Canonical code-section result card (shared by code.html and the index fallback). */
function codeResultCard(section) {
  const text = String(section.x || section.text || "");
  return `<article class="item"><h3>${esc(section.n || section.number || "")} ${esc(section.title || "")}</h3><div class="meta">${esc(section.a || section.articleTitle || "")}</div><p>${esc(text.slice(0, 420))}${text.length > 420 ? "…" : ""}</p>${(section.u || section.articleUrl) ? `<a href="${esc(href(section.u || section.articleUrl))}" rel="noopener noreferrer">source article</a>` : ""}</article>`;
}

/**
 * Sharded code-index matcher — mirrors the exporter's scoring contract
 * (pages_snapshot.ts scoreCodeSearchEntry, lane D §1, documented there):
 *   2 — every query term hits the identity field (number/title/article)
 *   1 — every query term hits the body text
 * Title/number hits rank above body hits; multi-word queries are AND semantics
 * (every whitespace-separated term must hit the same field). `cap` limits the
 * returned (already best-first) result list.
 */
function scoreCodeSearchEntry(identityText, bodyText, terms) {
  if (!terms.length) return -1;
  return terms.every(term => identityText.includes(term)) ? 2
    : terms.every(term => bodyText.includes(term)) ? 1
    : -1;
}
function searchIndexMatches(index, needle, cap = SEARCH_CAP) {
  const query = String(needle || "").trim().toLowerCase();
  if (!query || !index || !index.shards) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const identity = new Map((index.shards.t || []).map(entry => [entry.id, entry]));
  const bodyTextById = new Map((index.shards.x || []).map(entry => [entry.id, entry.x]));
  const scored = [];
  const seen = new Set();
  for (const entry of index.shards.t || []) {
    seen.add(entry.id);
    const score = scoreCodeSearchEntry(entry.t, bodyTextById.get(entry.id) || "", terms);
    if (score >= 0) scored.push({ score, match: { ...entry, x: bodyTextById.get(entry.id) || "" } });
  }
  for (const entry of index.shards.x || []) {
    if (seen.has(entry.id)) continue; // already scored via the identity shard
    const score = scoreCodeSearchEntry("", entry.x, terms);
    if (score >= 0 && identity.has(entry.id)) scored.push({ score, match: { ...identity.get(entry.id), x: entry.x } });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, cap * 4).map(item => item.match);
}
