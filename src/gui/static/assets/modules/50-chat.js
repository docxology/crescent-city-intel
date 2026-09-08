// 50-chat.js — RAG chat: model picker helpers, streaming send with AbortController, history.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    /** The model the picker has selected, or "" for the server default. */
    function chatSelectedModel() {
      const select = document.getElementById("chat-model");
      return select && select.value ? select.value : "";
    }

    /** Chat request body; `model` is omitted entirely when using the default. */
    function chatRequestBody(msg) {
      const body = { q: msg, history: chatHistory };
      const model = chatSelectedModel();
      if (model) body.model = model;
      return body;
    }

    // Chat send
    async function sendChat() {
      const msg = chatInput.value.trim();
      if (!msg) return;
      activeChatController?.abort();
      activeChatController = new AbortController();
      chatCancel.disabled = false;
      chatInput.value = "";

      const userDiv = document.createElement("div");
      userDiv.className = "chat-msg user";
      userDiv.textContent = msg;
      chatMessages.appendChild(userDiv);
      chatHistory.push({ role: "user", content: msg });

      // Show streaming assistant message
      const botDiv = document.createElement("div");
      botDiv.className = "chat-msg assistant";
      const answerText = document.createElement("div");
      answerText.innerHTML = '<span style="color:var(--text-secondary)">⏳ Thinking...</span>';
      botDiv.appendChild(answerText);
      chatMessages.appendChild(botDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Try SSE streaming first, fall back to regular /api/chat
      try {
        const resp = await apiFetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chatRequestBody(msg)),
          signal: activeChatController.signal,
        });

        if (resp.ok && resp.headers.get('Content-Type')?.includes('text/event-stream')) {
          // SSE streaming
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let fullAnswer = '';
          let buffer = '';
          let sourcesHtml = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('event: sources')) {
                // Next data line has sources
              } else if (line.startsWith('event: token')) {
                // Next data line has token
              } else if (line.startsWith('data: ')) {
                try {
                  const payload = JSON.parse(line.substring(6));
                  if (payload.token) {
                    fullAnswer += payload.token;
                    answerText.innerHTML = marked.parse(fullAnswer);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                  }
                  if (payload.sources) {
                    sourcesHtml = '<div class="chat-sources"><strong>Sources:</strong> ' +
                      payload.sources.map(s => `<span class="chat-source">§ ${s.sectionNumber}</span>`).join(' ') +
                      '</div>';
                  }
                  if (payload.answer) {
                    fullAnswer = payload.answer;
                    answerText.innerHTML = marked.parse(fullAnswer);
                  }
                  if (payload.sources && Array.isArray(payload.sources)) {
                    sourcesHtml = '<div class="chat-sources"><strong>Sources:</strong> ' +
                      payload.sources.map(s => `<span class="chat-source">§ ${s.sectionNumber}</span>`).join(' ') +
                      '</div>';
                  }
                } catch { /* skip malformed */ }
              }
            }
          }
          if (sourcesHtml) botDiv.insertAdjacentHTML('beforeend', sourcesHtml);
          chatHistory.push({ role: "assistant", content: fullAnswer });
          chatCancel.disabled = true;
          activeChatController = null;
          return;
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          answerText.innerHTML = '<span style="color:var(--text-secondary)">Cancelled.</span>';
          chatCancel.disabled = true;
          activeChatController = null;
          return;
        }
        /* fall through to regular chat */
      }

      // Fallback: regular /api/chat
      answerText.innerHTML = '<span style="color:var(--text-secondary)">⏳ Thinking...</span>';
      try {
        const selectedModel = chatSelectedModel();
        const modelParam = selectedModel ? `&model=${encodeURIComponent(selectedModel)}` : "";
        const resp = await apiFetch(`/api/chat?q=${encodeURIComponent(msg)}${modelParam}`, { signal: activeChatController.signal });
        const data = await resp.json();

        if (data.error) {
          answerText.innerHTML = `<span style="color:#f97316">${data.error}</span>`;
        } else {
          answerText.innerHTML = marked.parse(data.answer || "No response");
          if (data.answer) chatHistory.push({ role: "assistant", content: data.answer });
          if (data.sources && data.sources.length > 0) {
            const sourcesDiv = document.createElement("details");
            sourcesDiv.className = "chat-sources";
            const summary = document.createElement("summary");
            summary.textContent = `📚 ${data.sources.length} source${data.sources.length > 1 ? "s" : ""} cited`;
            sourcesDiv.appendChild(summary);
            for (const src of data.sources) {
              const srcDiv = document.createElement("div");
              srcDiv.className = "chat-source";
              // Link to section
              srcDiv.innerHTML = `<span class="score">${(src.score * 100).toFixed(0)}%</span> 
                <a href="#" onclick="loadSection('${src.sectionGuid}'); return false;">
                  ${escapeHtml(src.sectionNumber)} — ${escapeHtml(src.sectionTitle)}
                </a>`;
              sourcesDiv.appendChild(srcDiv);
            }
            botDiv.appendChild(sourcesDiv);
          }

          chatMessages.appendChild(botDiv);
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          answerText.innerHTML = '<span style="color:var(--text-secondary)">Cancelled.</span>';
          return;
        }
        const errDiv = document.createElement("div");
        errDiv.className = "chat-msg system";
        errDiv.textContent = "Failed to connect to chat service";
        chatMessages.appendChild(errDiv);
      }
      chatCancel.disabled = true;
      activeChatController = null;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    document.getElementById("chat-send").addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });
