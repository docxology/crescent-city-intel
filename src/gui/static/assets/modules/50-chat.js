import { runReaderTask, readerAwait, readerFetch } from "../reader-lifecycle.js";
import { apiFetch, chatCancel, chatInput, chatMessages, loadSection } from "./10-core.js";
import { CCGui } from "../gui-runtime.js";
import { appState } from "../app-state.js";
// Chat controller depends explicitly on CCGui transport/rendering and core refs.
function chatSelectedModel() { return document.getElementById("chat-model")?.value || ""; }
function chatRequestBody(msg, history = appState.chatHistory.slice(-6)) {
  const body = { q: msg, history }; const model = chatSelectedModel();
  if (model) body.model = model;
  return body;
}
function appendChatSources(container, sources) {
  if (!Array.isArray(sources) || !sources.length) return;
  const details = document.createElement("details"); details.className = "chat-sources";
  const summary = document.createElement("summary"); summary.textContent = `${sources.length} retrieved source records`; details.appendChild(summary);
  for (const source of sources) {
    const button = document.createElement("button"); button.type = "button"; button.className = "chat-source";
    button.textContent = `${source.sectionNumber || source.timestamp || "Source"} — ${source.sectionTitle || "Retrieved record"}`;
    if (source.sourceType === "youtube_transcript") {
      button.addEventListener("click", () => { if (/^[a-zA-Z0-9_-]{11}$/.test(source.videoId)) window.open(`https://www.youtube.com/watch?v=${source.videoId}`, "_blank", "noopener,noreferrer"); });
    } else button.addEventListener("click", () => loadSection(source.sectionGuid));
    details.appendChild(button);
  }
  container.appendChild(details);
}
async function sendChat() {
  const msg = chatInput.value.trim(); if (!msg) return;
  appState.activeChatController?.abort();
  const controller = new AbortController(), body = chatRequestBody(msg);
  appState.activeChatController = controller; chatCancel.disabled = false; chatInput.value = "";
  const user = document.createElement("div"); user.className = "chat-msg user"; user.textContent = msg; chatMessages.appendChild(user);
  const bot = document.createElement("div"); bot.className = "chat-msg assistant";
  const answer = document.createElement("div"), status = document.createElement("p");
  status.className = "chat-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.textContent = "Retrieving sources and preparing a response…";
  bot.append(answer, status); chatMessages.appendChild(bot);
  let text = "", sources = [], successful = false;
  try {
    let response = await apiFetch("/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if ([404, 405, 501].includes(response.status)) {
      // Capability fallback occurs before an accepted stream and preserves history.
      response = await apiFetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error("The chat helper could not complete this response.");
      text = result.answer || "No answer was returned."; sources = result.sources || [];
      successful = !!result.answer && result.evidence?.disposition !== "abstained";
      CCGui.render(answer, CCGui.markdown(text));
      status.textContent = successful ? "Generated response. Citation identity is checked; factual support has not been independently verified." : "Insufficient evidence; no successful conversation turn was retained.";
    } else {
      if (!response.ok || !response.headers.get("Content-Type")?.includes("text/event-stream")) throw new Error("The chat helper could not start this response.");
      const terminal = await CCGui.consumeSse(response, (event, payload) => {
        if (event === "sources") sources = payload;
        if (event === "token") { text += payload.token || ""; CCGui.render(answer, CCGui.markdown(text)); status.textContent = "Provisional response; waiting for completion."; }
      });
      if (terminal.name === "error") throw new Error(terminal.payload.status === "cancelled" ? "Request cancelled." : "The chat helper could not complete this response.");
      const result = terminal.payload;
      if (!["complete", "abstained"].includes(result.status) || typeof result.answer !== "string") throw new Error("Incomplete chat receipt.");
      text = result.answer; sources = result.sources || sources;
      CCGui.render(answer, CCGui.markdown(text)); successful = result.status === "complete";
      status.textContent = successful ? "Generated response. Citation identity is checked; factual support has not been independently verified." : "Insufficient evidence; no successful conversation turn was retained.";
    }
    appendChatSources(bot, sources);
    if (successful && appState.activeChatController === controller && !controller.signal.aborted) {
      appState.chatHistory.push({ role: "user", content: msg }, { role: "assistant", content: text });
      if (appState.chatHistory.length > 6) appState.chatHistory.splice(0, appState.chatHistory.length - 6);
    }
  } catch (error) {
    status.textContent = controller.signal.aborted ? "Cancelled. Any partial response is incomplete." : `${error.message || "Response failed."} Any partial response is incomplete.`;
    appendChatSources(bot, sources);
  } finally {
    if (appState.activeChatController === controller) { chatCancel.disabled = true; appState.activeChatController = null; }
    chatMessages.scrollTop = chatMessages.scrollHeight; if (document.getElementById("chat-panel").classList.contains("open")) chatInput.focus();
  }
}
document.getElementById("chat-send").addEventListener("click", sendChat);
chatInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); sendChat(); } });
window.addEventListener("pagehide", () => appState.activeChatController?.abort());

    async function loadChatModels() { return runReaderTask("chat-model", async signal => {
    const select = document.getElementById('chat-model');
    if (!select)
        return;
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, '/api/llm/models'), signal);
        if (!resp.ok)
            return;
        const data = await readerAwait(resp.json(), signal);
        if (data.status !== 'ok' || !Array.isArray(data.models))
            return;
        for (const model of data.models) {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model === data.configured ? model + ' (default)' : model;
            select.appendChild(option);
        }
        select.title = data.provider + ' · ' + data.count + ' model(s)';
    }
    catch { /* picker stays at "Default model" — never block chat on discovery */
        if (signal.aborted)
            return;
    }
}); }


export { loadChatModels };
