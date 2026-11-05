/**
 * The embeddable widget
 * ============================================================================
 *
 *   <script src="https://your-site/api/chat/public/widget.js" data-bot="help" defer></script>
 *
 * A button in a corner that opens a small chat in its own shadow DOM, so the page's styles do not reach it and
 * its styles do not reach the page. Answers arrive streamed (the AI SDK's UI message stream, read by hand: no
 * library on the visitor's page) and each one can be rated. Every text from the server is set with
 * `textContent`, never as HTML. The visitor key and the conversation live in the visitor's browser
 * (`localStorage`), per bot.
 */

export function widgetScript(): string {
  return `(() => {
  const script = document.currentScript;
  const slug = script && script.dataset.bot;
  if (!slug) return;
  const api = script.src.replace(/\\/public\\/widget\\.js.*$/, "");
  const bot = api + "/public/bots/" + encodeURIComponent(slug);
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  const keyName = "kitsuden-chat-visitor";
  let visitorId = store(keyName);
  if (!visitorId) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    visitorId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    store(keyName, visitorId);
  }
  const convName = "kitsuden-chat-" + slug;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = \`<style>
    :host { all: initial; }
    .launch { position: fixed; right: 20px; bottom: 20px; width: 52px; height: 52px; border-radius: 50%; border: 0; background: #1f2937; color: #fff; font: 600 22px system-ui; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 2147483000; }
    .panel { position: fixed; right: 20px; bottom: 84px; width: min(360px, calc(100vw - 40px)); height: min(520px, calc(100vh - 120px)); background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.25); display: none; flex-direction: column; font: 14px/1.45 system-ui, sans-serif; z-index: 2147483000; overflow: hidden; }
    .panel.open { display: flex; }
    header { padding: 12px 14px; background: #1f2937; color: #fff; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    header button { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.4); border-radius: 6px; font: 12px system-ui; padding: 3px 8px; cursor: pointer; }
    .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 85%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word; }
    .bot { background: #f3f4f6; align-self: flex-start; }
    .me { background: #1f2937; color: #fff; align-self: flex-end; }
    .meta { font-size: 12px; color: #6b7280; align-self: flex-start; display: flex; gap: 6px; align-items: center; }
    .meta button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; padding: 1px 6px; }
    .meta button[aria-pressed="true"] { background: #1f2937; color: #fff; }
    form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #e5e7eb; }
    input { flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }
    button.send { padding: 8px 12px; border: 0; border-radius: 8px; background: #1f2937; color: #fff; font: inherit; cursor: pointer; }
  </style>
  <button class="launch" aria-label="Open chat">?</button>
  <div class="panel" role="dialog" aria-label="Chat"><header><span class="title"></span><button class="new" title="Start over">New</button></header><div class="log" aria-live="polite"></div>
  <form><input maxlength="2000" aria-label="Your question" /><button class="send">Send</button></form></div>\`;
  document.body.appendChild(host);
  const panel = root.querySelector(".panel");
  const log = root.querySelector(".log");
  const input = root.querySelector("input");
  const add = (text, cls) => { const el = document.createElement("div"); el.className = cls; el.textContent = text; log.appendChild(el); log.scrollTop = log.scrollHeight; return el; };
  const rateRow = (messageId, sources) => {
    const row = document.createElement("div");
    row.className = "meta";
    if (sources.length) row.append("Sources: " + sources.join(", ") + " ");
    for (const [label, rating] of [["👍", 1], ["👎", -1]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-label", rating === 1 ? "Good answer" : "Bad answer");
      b.addEventListener("click", async () => {
        row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        try { await fetch(bot + "/messages/" + encodeURIComponent(messageId) + "/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visitorId, rating }) }); } catch (e) {}
      });
      row.append(b);
    }
    log.appendChild(row);
  };
  let loaded = false;
  root.querySelector(".launch").addEventListener("click", async () => {
    panel.classList.toggle("open");
    if (loaded) return;
    loaded = true;
    try {
      const body = await (await fetch(bot)).json();
      root.querySelector(".title").textContent = (body.data && body.data.name) || "Chat";
      if (body.data && body.data.greeting) add(body.data.greeting, "msg bot");
    } catch (e) { root.querySelector(".title").textContent = "Chat"; }
    input.focus();
  });
  root.querySelector(".new").addEventListener("click", () => { store(convName, ""); log.replaceChildren(); });
  root.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    add(message, "msg me");
    const answer = add("…", "msg bot");
    let text = "";
    const sources = [];
    let messageId = null;
    try {
      const res = await fetch(bot + "/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, visitorId, conversationId: store(convName) || undefined }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        answer.textContent = (body.error && body.error.message) || "The assistant could not answer.";
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\\n\\n")) >= 0) {
          const line = buffer.slice(0, cut).replace(/^data: /, "");
          buffer = buffer.slice(cut + 2);
          if (line === "[DONE]") continue;
          let part;
          try { part = JSON.parse(line); } catch (e) { continue; }
          if (part.type === "text-delta") { text += part.delta; answer.textContent = text; log.scrollTop = log.scrollHeight; }
          else if (part.type === "source-document") sources.push(part.title);
          else if (part.type === "data-chat") { store(convName, part.data.conversationId); messageId = part.data.messageId; }
          else if (part.type === "error") answer.textContent = part.errorText;
        }
      }
      if (messageId) rateRow(messageId, sources);
    } catch (e) { answer.textContent = "The assistant could not answer."; }
  });
})();`;
}
