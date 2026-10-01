/** Explicit request ownership, cancellation, announcements and keyboard focus. */
const tasks = new Map();
let returnFocus = null;
export function announce(message) {
  let live = document.getElementById('reader-announcement');
  if (!live) { live = document.createElement('p'); live.id = 'reader-announcement'; live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); document.body.append(live); }
  live.textContent = message;
}
export async function readerAwait(value, signal) { const result = await value; signal.throwIfAborted(); return result; }
export function readerFetch(fetcher, signal, url, options = {}) {
  return fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
}
export async function runReaderTask(targetId, task) {
  const target = document.getElementById(targetId); if (!target) return;
  tasks.get(targetId)?.controller.abort();
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  const owner = { controller, target }; tasks.set(targetId, owner);
  let controls = document.getElementById(`${targetId}-request-controls`);
  if (!controls) { controls = document.createElement('div'); controls.id = `${targetId}-request-controls`; controls.className = 'reader-request-controls'; target.before(controls); }
  controls.replaceChildren();
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = 'Loading…';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel loading'; cancel.addEventListener('click', () => controller.abort());
  controls.append(status, cancel); target.setAttribute('aria-busy', 'true'); target.dataset.requestState = 'loading';
  try { return await task(signal); }
  catch (error) { if (!signal.aborted && tasks.get(targetId) === owner) { target.textContent = 'This reader could not load its data. Use Retry to try again.'; target.dataset.requestState = 'failed'; } }
  finally {
    if (tasks.get(targetId) === owner) {
      tasks.delete(targetId); target.setAttribute('aria-busy', 'false');
      if (signal.aborted) { target.textContent = 'Loading cancelled. Use Retry to try again.'; target.dataset.requestState = 'cancelled'; }
      else if (target.dataset.requestState !== 'failed') target.dataset.requestState = 'settled';
      status.textContent = signal.aborted ? 'Loading cancelled.' : target.dataset.requestState === 'failed' ? 'Loading failed.' : 'Loading finished; source gaps are shown below.';
      const hadFocus = document.activeElement === cancel;
      cancel.textContent = 'Retry'; cancel.replaceWith(cancel.cloneNode(true)); const retry = controls.querySelector('button'); retry.addEventListener('click', () => runReaderTask(targetId, task)); if (hadFocus) retry.focus();
      announce(status.textContent);
    }
  }
}
export function cancelReaderTasks(within) { for (const { controller, target } of tasks.values()) if (!within || within.contains(target)) controller.abort(); }
export function initializeReaderFocus(closeAll) {
  // The overlay offset includes the masthead/banners; it must not determine
  // the navigation header's own height, which would create layout feedback.
  const header = document.getElementById('header');
  const updateHeaderOffset = () => document.documentElement.style.setProperty('--header-height', `${header.getBoundingClientRect().bottom}px`);
  const layout = new ResizeObserver(updateHeaderOffset); layout.observe(header);
  for (const sibling of document.body.children) if (sibling !== header && sibling.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING) layout.observe(sibling);
  window.addEventListener('resize', updateHeaderOffset); updateHeaderOffset();
  const surfaces = [ ['analytics-toggle','analytics-overlay'], ['feeds-toggle','feeds-overlay'], ['sources-toggle','sources-overlay'], ['alerts-toggle','alerts-panel'], ['chat-toggle','chat-panel'], ['dev-toggle','dev-overlay'] ];
  const open = element => element.id === 'alerts-panel' ? element.style.display !== 'none' : element.classList.contains('open');
  let previous = null;
  const sync = () => {
    const active = surfaces.find(([,id]) => open(document.getElementById(id)));
    document.getElementById('sidebar').inert = Boolean(active); document.getElementById('code-reader').inert = Boolean(active);
    for (const [toggle,id] of surfaces) { const element = document.getElementById(id), isOpen = open(element); document.getElementById(toggle).setAttribute('aria-expanded', String(isOpen)); document.getElementById(toggle).setAttribute('aria-controls', id); element.inert = !isOpen; element.setAttribute('aria-hidden', String(!isOpen)); }
    if (active?.[1] !== previous) {
      if (active) { returnFocus = document.getElementById(active[0]); const element = document.getElementById(active[1]); const focus = element.querySelector('.intel-tab.active, input, button, h2'); if (focus) { if (/^H/.test(focus.tagName)) focus.tabIndex = -1; focus.focus({preventScroll:true}); } announce(`${returnFocus.textContent.trim()} opened.`); }
      previous = active?.[1] ?? null;
    }
  };
  for (const [,id] of surfaces) new MutationObserver(sync).observe(document.getElementById(id), {attributes:true, attributeFilter:['class','style']});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && surfaces.some(([,id]) => open(document.getElementById(id)))) { event.preventDefault(); closeAll(); returnFocus?.focus(); announce('Returned to the code reader.'); }
  });
  window.addEventListener('pagehide', () => cancelReaderTasks()); sync();
}
export function initializeStandalone() {
  for (const section of document.querySelectorAll('main section')) {
    const heading = section.querySelector('h2'); if (heading) { heading.id ||= `${section.id}-heading`; section.setAttribute('aria-labelledby', heading.id); }
    for (const input of section.querySelectorAll('input')) input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); section.querySelector('button')?.click(); } });
  }
  window.addEventListener('pagehide', () => cancelReaderTasks());
  document.documentElement.dataset.readerReady = 'true';
}
