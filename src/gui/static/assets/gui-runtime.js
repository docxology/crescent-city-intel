/* Local GUI foundation v1. No third-party runtime or network-loaded code. */
export const CCGui = (() => {
  "use strict";
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const nativeSet = descriptor.set;
  const escape = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  function safeUrl(value) {
    try { const url = new URL(String(value), location.href); return !url.username && !url.password && ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  const tags = new Set("a abbr b blockquote br button canvas caption circle code col colgroup dd details div dl dt em g h1 h2 h3 h4 h5 h6 hr i img input label li line main ol optgroup option p path polygon polyline pre rect s section select small span strong sub summary sup svg table tbody td textarea th thead time tr ul".split(" "));
  // These properties cannot select an image/font/document resource. Parse the
  // browser's declarations instead of trying to enumerate every CSS URL form.
  const safeStyleProperties = "display position top right bottom left inset z-index width height min-width min-height max-width max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left gap row-gap column-gap overflow overflow-x overflow-y box-sizing opacity color background-color border border-top border-right border-bottom border-left border-color border-width border-style border-radius font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-overflow text-transform white-space vertical-align visibility word-break overflow-wrap transform transform-origin flex flex-direction flex-wrap flex-grow flex-shrink flex-basis justify-content align-items align-content align-self grid-template-columns grid-template-rows grid-column grid-row pointer-events fill stroke stroke-width stroke-linecap stroke-linejoin".split(" ");
  function sanitizeStyle(element) {
    const original = element.getAttribute("style") || "";
    if (/url\s*\(|expression\s*\(|@|\\|behavior\s*:|-moz-binding/i.test(original)) { element.removeAttribute("style"); return; }
    const safe = document.createElement("span").style;
    for (const property of safeStyleProperties) {
      const value = element.style.getPropertyValue(property);
      if (value) safe.setProperty(property, value);
    }
    if (safe.cssText) element.setAttribute("style", safe.cssText);
    else element.removeAttribute("style");
  }
  function sanitizeHtml(value) {
    const template = document.createElement("template");
    nativeSet.call(template, String(value ?? ""));
    for (const element of [...template.content.querySelectorAll("*")]) {
      if (!tags.has(element.localName)) { element.remove(); continue; }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || ["srcdoc", "nonce", "formaction", "action", "srcset", "ping", "background", "poster"].includes(name)) { element.removeAttribute(attribute.name); continue; }
        if (["href", "xlink:href", "src"].includes(name)) {
          const safe = safeUrl(attribute.value);
          // Images may load local assets only. Generated content cannot trigger remote requests.
          if (!safe || (name === "src" && new URL(safe).origin !== location.origin)) element.removeAttribute(attribute.name);
          else element.setAttribute(attribute.name, safe);
        }
        if (name === "style") sanitizeStyle(element);
      }
      for (const name of ["fill", "stroke", "filter", "clip-path", "mask", "cursor"]) if (/url|\\|@/i.test(element.getAttribute(name) || "")) element.removeAttribute(name);
      if (element.localName === "a") element.setAttribute("rel", "noopener noreferrer");
    }
    return descriptor.get.call(template);
  }
  function render(element, value) { nativeSet.call(element, sanitizeHtml(value)); }
  function markdown(text) {
    const inline = value => escape(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => { const safe = safeUrl(href.replace(/&amp;/g, "&")); return safe ? `<a href="${escape(safe)}" rel="noopener noreferrer">${label}</a>` : label; });
    return String(text ?? "").slice(0, 200_000).split(/\n\s*\n/).map(block => {
      if (block.startsWith("```")) return `<pre><code>${escape(block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, ""))}</code></pre>`;
      const heading = /^(#{1,6})\s+(.+)$/.exec(block);
      if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
      return `<p>${inline(block).replace(/\n/g, "<br>")}</p>`;
    }).join("");
  }
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key, fallback) { try { const value = JSON.parse(this.get(key)); return Array.isArray(value) ? value : fallback; } catch { return fallback; } },
  };
  let memoryKey = null;
  function setApiKey(value) {
    if (typeof value !== "string" || value.length > 512 || /[\r\n]/.test(value)) throw new Error("Invalid API key format");
    memoryKey = value.trim();
  }
  function clearApiKey() { memoryKey = ""; }
  function revealCredentials() {
    const details = document.getElementById("api-credentials"); if (details) details.open = true;
    const status = document.getElementById("api-credentials-status"); if (status) status.textContent = "API access requires a valid key for this server. Enter it here, then retry the action.";
  }
  function wireCredentials() {
    const form = document.getElementById("api-credentials-form"), input = document.getElementById("api-credentials-key"), status = document.getElementById("api-credentials-status");
    if (!form || !input || !status) return;
    form.addEventListener("submit", event => {
      event.preventDefault();
      try { setApiKey(input.value); input.value = ""; status.textContent = "Key held in memory for this tab. Retry the action to use it."; }
      catch { status.textContent = "The key format is invalid. Enter a single-line API key."; }
    });
    document.getElementById("api-credentials-clear")?.addEventListener("click", () => { clearApiKey(); input.value = ""; status.textContent = "Key cleared. This tab will send no API key."; });
  }
  document.addEventListener("DOMContentLoaded", wireCredentials, { once: true });
  async function apiFetch(input, options = {}) {
    const url = new URL(input, location.href), headers = new Headers(options.headers);
    const key = memoryKey === null ? window.__CC_API_KEY__ : memoryKey;
    if (url.origin === location.origin && url.pathname.startsWith("/api/") && key && !key.startsWith("__CC_API_KEY")) headers.set("X-API-Key", key);
    if (url.origin !== location.origin) headers.delete("X-API-Key");
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    const response = await fetch(url, { ...options, headers, signal, redirect: "error" });
    if (url.origin === location.origin && url.pathname.startsWith("/api/") && response.status === 401) revealCredentials();
    return response;
  }
  async function consumeSse(response, onEvent) {
    if (!response.body) throw new Error("No response stream");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", terminal = null, bytes = 0;
    function frame(text) {
      let name = "message"; const data = [];
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      const payload = JSON.parse(data.join("\n"));
      if (name === "done" || name === "error") {
        if (terminal) throw new Error("Multiple terminal events"); terminal = { name, payload };
      } else if (terminal) throw new Error("Data after terminal event");
      onEvent(name, payload);
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        bytes += value.byteLength; if (bytes > 2_000_000) throw new Error("Response too large");
        buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) { frame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
      }
      if (buffer.trim()) frame(buffer);
      if (!terminal) throw new Error("Answer stream ended before completion");
      return terminal;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return Object.freeze({ escape, safeUrl, sanitizeHtml, render, markdown, storage, apiFetch, consumeSse, setApiKey, clearApiKey });
})();
// Public diagnostics/credential control remains deliberate; controllers import this binding.
window.CCGui = CCGui;
