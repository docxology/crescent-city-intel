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
/**
 * List-context empty state (P1-G). `empty()` returns a <div>, which is invalid
 * inside the <ol id="event-items"> calendar list; every list path uses this
 * instead so the loading, error, and no-match states are real list items.
 */
const emptyListItem = message => `<li class="item meta">${esc(message)}</li>`;
/**
 * P0.6: operator diagnostics (fetch URLs, "Failed to parse JSON", DNS codes)
 * are facts about the operator's machine, not public copy. Public surfaces keep
 * the fact that a check did not succeed and drop the internals, mapping the raw
 * string onto a closed set of honest public phrases — an unrecognised error is
 * never passed through verbatim, and is never reported as a success either.
 */
function publicErrorNote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/timed? ?out|timeout|abort/i.test(raw)) return "the request timed out before a response arrived";
  const httpStatus = /\b([45]\d{2})\b/.exec(raw);
  if (httpStatus) return `the source returned HTTP ${httpStatus[1]}`;
  if (/parse|json|xml|unexpected token|syntaxerror/i.test(raw)) return "the response could not be parsed";
  if (/enotfound|econnrefused|econnreset|dns|network|fetch failed|socket|tls|certificate/i.test(raw)) return "the source could not be reached";
  return "the last check did not succeed";
}
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
  // P1-L: meeting records carry their agenda/minutes documents as structured
  // {label, url} pairs; they render as labelled links, never as raw URL text.
  const documents = (Array.isArray(item.documents) ? item.documents : []).filter(doc => doc && /^https?:\/\//i.test(String(doc.url || "")));
  const documentsHtml = documents.length ? `<div class="meta">${documents.map(doc => `<a href="${esc(href(doc.url))}" rel="noopener noreferrer">${esc(doc.label || "Document")}</a>`).join(" \u00b7 ")}</div>` : "";
  // §2.7: only wrap the title in an anchor when a real http(s) link exists.
  const heading = /^https?:\/\//i.test(String(item.link || "")) ? `<a href="${esc(link)}" rel="noopener noreferrer">${title}</a>` : title;
  return `<article class="item"><h3>${heading}</h3><div class="meta">${source}${when ? ` · ${esc(date(when))}` : ""}</div>${detail ? `<p>${detail}</p>` : ""}${documentsHtml}${tags}</article>`;
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

/** Map each event kind to a chip modifier class (palette: --cc/--rdark/--rtint family only). */
const EVENT_KIND_CHIP_CLASS = { "government-meeting": "meeting", "community-listing": "community", "civic-news": "news", youtube: "youtube", "holiday-closure": "closure" };

/** Map an event kind onto the kind-<select> value that selects it (chip -> one shared filter state). */
function eventKindFilterValue(kind) {
  if (kind === "government-meeting") return "meetings";
  if (kind === "youtube") return "youtube";
  if (kind === "holiday-closure") return "holiday-closure";
  return "community";
}

/**
 * Per-kind chip for calendar entries (P1-B). The chip is a real filter button,
 * not a decorative span with an invented aria-label: it carries the kind filter
 * it applies, its pressed state reflects the one shared filter value, and it
 * controls the list it filters. `activeFilter` is the current kind-select value.
 */
function calendarEventKindChip(event, activeFilter) {
  const kind = String(event && event.kind || "");
  const label = EVENT_KIND_LABELS[kind] || kind || "Event";
  const cls = EVENT_KIND_CHIP_CLASS[kind] || "other";
  const filterValue = eventKindFilterValue(kind);
  const pressed = String(activeFilter || "") === filterValue ? "true" : "false";
  return `<button type="button" class="kind-chip kind-chip--${esc(cls)}" data-kind="${esc(kind)}" data-kind-filter="${esc(filterValue)}" aria-pressed="${esc(pressed)}" aria-controls="event-items" aria-label="Filter events by kind: ${esc(label)}">${esc(label)}</button>`;
}

/**
 * P1-B wiring: chip clicks drive the same kind <select> a keyboard user drives,
 * so there is one filter state and no second, silent one. Clicks are delegated
 * from the list container, so cards re-rendered after a filter change stay wired.
 */
function wireCalendarKindChips(listId, selectId, onChange) {
  const list = document.getElementById(listId);
  const select = document.getElementById(selectId);
  if (!list || !select) return;
  list.addEventListener("click", event => {
    const chip = event.target && event.target.closest ? event.target.closest("[data-kind-filter]") : null;
    if (!chip || !list.contains(chip)) return;
    const value = chip.getAttribute("data-kind-filter") || "all";
    select.value = chip.getAttribute("aria-pressed") === "true" ? "all" : value;
    onChange(select.value);
  });
}

/**
 * Deterministic civic-timezone window filter — the single calendar window state
 * (P1-D; the page previously ran a select and a button group against separate,
 * uncoordinated states). "week" = current Monday-Sunday window, "month" =
 * current calendar month, both computed in CIVIC_TZ from `now` (or the real
 * clock); "upcoming"/"past" read the event's recorded status. Undated events are
 * excluded from the date windows, never guessed into one; any other window
 * value ("all") is a no-op passthrough.
 */
function calendarWindowFilter(events, window, now) {
  if (window === "upcoming") return (events || []).filter(event => event && event.status === "scheduled");
  if (window === "past") return (events || []).filter(event => event && event.status === "completed");
  if (window !== "week" && window !== "month") return events || [];
  const ref = civicDayStamp((now instanceof Date ? now : new Date()).toISOString());
  if (ref === null) return [];
  const refYear = Math.floor(ref / 10000);
  const refMonth = Math.floor(ref / 100) % 100;
  const refDate = new Date(Date.UTC(refYear, refMonth - 1, ref % 100));
  const dayMs = 86400000;
  const start = window === "week"
    ? refDate.getTime() - ((refDate.getUTCDay() + 6) % 7) * dayMs
    : Date.UTC(refYear, refMonth - 1, 1);
  const end = window === "week"
    ? start + 7 * dayMs
    : Date.UTC(refMonth === 12 ? refYear + 1 : refYear, refMonth === 12 ? 0 : refMonth, 1);
  return (events || []).filter(event => {
    const stamp = civicDayStamp(`${String(event && event.dateStart || "").slice(0, 10)}T12:00:00Z`);
    if (stamp === null) return false;
    const day = Date.UTC(Math.floor(stamp / 10000), Math.floor(stamp / 100) % 100 - 1, stamp % 100);
    return day >= start && day < end;
  });
}

/**
 * P1-H: one wiring for the calendar window control, shared by events.html and
 * the front page (the loop was byte-identical in both). The group is
 * single-select: exactly one button is aria-pressed, and its data-window value
 * is the single window state the list reads (P1-D).
 */
function wireCalendarWindowButtons(containerId, state, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const buttons = Array.from(container.querySelectorAll(".window-btn"));
  const sync = () => {
    for (const button of buttons) button.setAttribute("aria-pressed", button.getAttribute("data-window") === state.window ? "true" : "false");
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      state.window = button.getAttribute("data-window") || "all";
      sync();
      onChange(state.window);
    });
  }
  sync();
}

/**
 * P1-E: the calendar freshness line. An absent or unparseable generatedAt
 * renders nothing — a missing timestamp is not an age of NaN days.
 */
function calendarFreshnessText(generatedAt) {
  const stamp = Date.parse(String(generatedAt || ""));
  if (!Number.isFinite(stamp)) return "";
  const days = Math.floor((Date.now() - stamp) / 86400000);
  if (!Number.isFinite(days)) return "";
  const day = String(generatedAt).slice(0, 10);
  return days >= 7
    ? `Calendar data refreshed ${day} \u2014 ${days} days old; the next collection cycle may add newer events.`
    : `Calendar data refreshed ${day}.`;
}

/**
 * P0.1: search over a lazily-loaded index. The code pages load the sharded
 * search index on the first query; before this, that first query rendered
 * "Showing 0 of 0" against a null index and nothing ever re-ran it, so the page
 * stayed empty until the visitor typed again. `search(needle)` renders what is
 * available now and re-renders the same needle once the index settles.
 * `render(needle, index, state)` receives state "ready" | "pending" |
 * "unavailable" so the caller can show a pending line instead of a false zero.
 */
function createDeferredIndexSearch(loadIndex, render) {
  let index = null;
  let pending = false;
  let failed = false;
  let lastNeedle = "";
  const indexState = () => (index ? "ready" : failed ? "unavailable" : "pending");
  const draw = () => render(lastNeedle, index, indexState());
  const begin = () => {
    if (index || pending || failed || typeof loadIndex !== "function") return;
    pending = true;
    Promise.resolve()
      .then(() => loadIndex())
      .then(loaded => { index = loaded || null; failed = !loaded; })
      .catch(() => { failed = true; })
      .finally(() => { pending = false; draw(); });
  };
  return {
    search(needle) {
      lastNeedle = String(needle || "");
      if (lastNeedle) begin();
      draw();
    },
  };
}

/** Calendar event list item (canonical: index.html copy with status chip, day hint, LLM summary, provenance links). */
function calendarEventCard(event, summaries, activeFilter) {
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
  return `<li class="item cal-entry">${calendarEventKindChip(event, activeFilter)}<div class="cal-when">${timeEl ? `<span class="cal-time">${timeEl}</span>` : ""}</div>${titleHtml}<div class="meta">${hint}</div><div>${eventStatusChip(event.status)}</div>${placeHtml ? `<div class="meta">${placeHtml}</div>` : ""}${summaryHtml}${linksHtml}</li>`;
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
  return `<article class="source ${esc(source.status)}"><h3>${esc(source.source)}</h3><div>${status(source.status)} · ${esc(source.itemCount)} item(s)</div><div class="meta">Checked ${esc(date(source.checkedAt))}${source.fetchedAt ? ` · fetched ${esc(date(source.fetchedAt))}` : ""}${source.ageMs != null ? ` · age ${esc(Math.round(source.ageMs / 3600000))}h` : ""}</div>${source.provenance ? `<div class="meta">${esc(source.provenance)}</div>` : ""}${source.url ? `<div><a href="${esc(href(source.url))}" rel="noopener noreferrer">source</a></div>` : ""}${source.error ? `<div class="error">Source check note: ${esc(publicErrorNote(source.error))}</div>` : ""}</article>`;
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
