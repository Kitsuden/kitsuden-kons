/*
 * koe web chat: the embeddable widget.
 *
 *   <script src="https://<api>/api/koe/public/webchat/widget.js" data-key="<channel key>" crossorigin="anonymous" defer></script>
 *
 * Optional attributes: data-color="#0b5fff" (the button and your bubbles), data-position="left",
 * data-open="true" (opens on load), data-realtime="wss://<api>/api/realtime" (when the API is not at
 * the usual place).
 *
 * A button in a corner opens a small chat in its own shadow DOM: the page's styles do not reach it, and its
 * styles (an adopted stylesheet, so a strict CSP without 'unsafe-inline' still applies them) do not reach
 * the page. The visitor is a random key kept in localStorage per chat; the server stores only its hash.
 * Answers arrive on the visitor's realtime channel when the API lets this site open its WebSocket, and by
 * polling every few seconds otherwise. Every text from the server is set with textContent and every link
 * is checked to be http(s): nothing is parsed as HTML, nothing is evaluated.
 *
 * Served by GET <koe>/public/webchat/widget.js (koe.ops.web.ts). No dependencies.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script || !script.dataset || !script.dataset.key) return;
  var KEY = script.dataset.key;
  window.__koeWebchat = window.__koeWebchat || {};
  if (window.__koeWebchat[KEY]) return; // the snippet pasted twice
  window.__koeWebchat[KEY] = true;

  // ── Strings (one place, for translation) ────────────────────────────────
  var L = {
    open: "Open chat",
    close: "Close chat",
    title: "Chat",
    message: "Message",
    placeholder: "Write a message…",
    send: "Send",
    sending: "Sending…",
    failed: "Not sent.",
    retry: "Retry",
    tooMany: "Too many messages. Try again in a minute.",
    offline: "Cannot reach the chat. Retrying…",
    name: "Your name",
    email: "Your email",
    start: "Start chat",
    prechat: "Before we start",
    unread: function (n) {
      return n === 1 ? "1 new message" : n + " new messages";
    },
    you: "You",
    them: "Reply",
    file: "File",
    options: "Options",
  };

  // ── Where the API is ────────────────────────────────────────────────────
  var BASE = script.src.replace(/\/public\/webchat\/widget\.js(?:[?#].*)?$/, "");
  var CHAT = BASE + "/public/webchat/" + encodeURIComponent(KEY);
  var REALTIME = script.dataset.realtime || BASE.replace(/^http/, "ws").replace(/\/[^/]+$/, "/realtime");
  var COLOR = /^#[0-9a-fA-F]{3,8}$/.test(script.dataset.color || "") ? script.dataset.color : "#1d4ed8";
  var LEFT = script.dataset.position === "left";

  // ── The visitor ─────────────────────────────────────────────────────────
  function store(k, v) {
    try {
      if (v === undefined) return window.localStorage.getItem(k);
      if (v === null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } catch (e) {
      /* private mode: the chat still works for this page view */
    }
    return null;
  }
  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    window.crypto.getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return s;
  }
  var VISITOR_KEY = "koe:visitor:" + KEY;
  var visitorId = store(VISITOR_KEY);
  if (!visitorId || visitorId.length < 24) {
    visitorId = randomHex(24);
    store(VISITOR_KEY, visitorId);
  }
  var PROFILE_KEY = "koe:profile:" + KEY;
  var SEEN_KEY = "koe:seen:" + KEY;
  var profile = null;
  try {
    profile = JSON.parse(store(PROFILE_KEY) || "null");
  } catch (e) {
    profile = null;
  }

  // ── DOM helpers: elements only, never HTML strings ──────────────────────
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "text") el.textContent = v;
        else if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) if (children[i]) el.appendChild(children[i]);
    }
    return el;
  }
  function safeUrl(raw) {
    if (typeof raw !== "string" || !raw) return null;
    try {
      var u = new URL(raw, BASE);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    // Rules below set `display`, which would beat the `hidden` attribute: it wins back here.
    "[hidden]{display:none!important}",
    ".launch{position:fixed;bottom:20px;" + (LEFT ? "left" : "right") + ":20px;width:56px;height:56px;border-radius:50%;border:0;background:var(--koe-accent);color:#fff;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center}",
    ".launch svg{width:26px;height:26px}",
    ".launch:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--koe-accent);outline-offset:2px}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#dc2626;color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center}",
    ".badge[hidden]{display:none}",
    ".panel{position:fixed;bottom:88px;" + (LEFT ? "left" : "right") + ":20px;width:min(380px,calc(100vw - 40px));height:min(560px,calc(100vh - 120px));background:var(--koe-bg);color:var(--koe-text);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;z-index:2147483000;overflow:hidden}",
    ".panel[hidden]{display:none}",
    "header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--koe-accent);color:#fff}",
    "header h2{margin:0;font-size:15px;font-weight:600}",
    "header button{background:transparent;border:0;color:#fff;cursor:pointer;width:32px;height:32px;border-radius:8px;font-size:20px;line-height:1}",
    "header button:hover{background:rgba(255,255,255,.15)}",
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}",
    ".row{display:flex;flex-direction:column;max-width:85%;gap:4px}",
    ".row.me{align-self:flex-end;align-items:flex-end}",
    ".row.them{align-self:flex-start;align-items:flex-start}",
    ".bubble{padding:8px 11px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}",
    ".me .bubble{background:var(--koe-accent);color:#fff;border-bottom-right-radius:4px}",
    ".them .bubble{background:var(--koe-surface);color:var(--koe-text);border-bottom-left-radius:4px}",
    ".bubble img,.bubble video{display:block;max-width:100%;max-height:260px;border-radius:8px}",
    ".bubble audio{display:block;max-width:100%}",
    ".bubble a{color:inherit;text-decoration:underline}",
    ".sticker{max-width:140px;max-height:140px}",
    ".meta{font-size:11px;color:var(--koe-dim)}",
    ".meta button{font:inherit;color:var(--koe-accent);background:none;border:0;padding:0 0 0 6px;cursor:pointer;text-decoration:underline}",
    ".choices{display:flex;flex-wrap:wrap;gap:6px}",
    ".choices button,.choices a{font:inherit;padding:6px 10px;border-radius:999px;border:1px solid var(--koe-accent);background:var(--koe-bg);color:var(--koe-accent);cursor:pointer;text-decoration:none}",
    ".choices button[aria-pressed=true]{background:var(--koe-accent);color:#fff}",
    ".choices button:disabled{cursor:default;opacity:.6}",
    ".choices button[aria-pressed=true]:disabled{opacity:1}",
    ".list{display:flex;flex-direction:column;gap:4px;margin-top:6px}",
    ".list .section{font-size:12px;color:var(--koe-dim);margin-top:4px}",
    ".list button{text-align:left;border-radius:10px}",
    ".list small{display:block;color:var(--koe-dim)}",
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--koe-border);align-items:flex-end}",
    "textarea{flex:1;resize:none;max-height:120px;min-height:40px;padding:9px 11px;border:1px solid var(--koe-border);border-radius:10px;font:inherit;color:var(--koe-text);background:var(--koe-bg)}",
    ".send{padding:0 14px;height:40px;border:0;border-radius:10px;background:var(--koe-accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}",
    ".send:disabled{opacity:.5;cursor:default}",
    ".prechat{flex-direction:column;align-items:stretch;padding:14px;gap:10px;border-top:0}",
    ".prechat h3{margin:0;font-size:14px}",
    ".prechat label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--koe-dim)}",
    ".prechat input{padding:9px 11px;border:1px solid var(--koe-border);border-radius:10px;font:inherit;color:var(--koe-text);background:var(--koe-bg)}",
    ".status{padding:0 14px 8px;font-size:12px;color:#b91c1c}",
    ".status:empty{display:none}",
    ".sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}",
    "@media (max-width:480px){.panel{inset:0;width:100%;height:100%;border-radius:0}.panel:not([hidden])~.launch{display:none}}",
    "@media (prefers-reduced-motion:no-preference){.panel{transition:opacity .15s ease}}",
  ].join("\n");

  // ── The frame ───────────────────────────────────────────────────────────
  var host = h("div", { "data-koe-webchat": KEY });
  var root = host.attachShadow({ mode: "open" });
  var sheet = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch (e) {
    root.appendChild(h("style", { text: CSS }));
  }
  var vars = root.host.style;
  vars.setProperty("--koe-accent", COLOR);
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function paint() {
    var d = dark && dark.matches;
    vars.setProperty("--koe-bg", d ? "#111827" : "#ffffff");
    vars.setProperty("--koe-surface", d ? "#1f2937" : "#f1f5f9");
    vars.setProperty("--koe-text", d ? "#f9fafb" : "#0f172a");
    vars.setProperty("--koe-dim", d ? "#9ca3af" : "#475569");
    vars.setProperty("--koe-border", d ? "#374151" : "#cbd5e1");
  }
  paint();
  if (dark && dark.addEventListener) dark.addEventListener("change", paint);

  var panelId = "koe-panel-" + KEY.replace(/[^A-Za-z0-9_-]/g, "");
  var titleEl = h("h2", { id: panelId + "-title", text: L.title });
  var closeBtn = h("button", { type: "button", "aria-label": L.close, text: "×" });
  var log = h("div", { class: "log", role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "0", "aria-label": L.title });
  var status = h("div", { class: "status", role: "status" });
  var input = h("textarea", { id: panelId + "-input", rows: "1", maxlength: "4000", placeholder: L.placeholder, autocomplete: "off" });
  var sendBtn = h("button", { class: "send", type: "submit", text: L.send });
  var composer = h("form", { class: "composer", "aria-label": L.message }, [h("label", { class: "sr", for: panelId + "-input", text: L.message }), input, sendBtn]);
  var nameIn = h("input", { type: "text", maxlength: "200", autocomplete: "name", required: true });
  var emailIn = h("input", { type: "email", maxlength: "300", autocomplete: "email" });
  var prechat = h("form", { class: "prechat", "aria-labelledby": panelId + "-pre", hidden: true }, [
    h("h3", { id: panelId + "-pre", text: L.prechat }),
    h("label", null, [document.createTextNode(L.name), nameIn]),
    h("label", null, [document.createTextNode(L.email), emailIn]),
    h("button", { class: "send", type: "submit", text: L.start }),
  ]);
  var panel = h("div", { class: "panel", id: panelId, role: "dialog", "aria-labelledby": panelId + "-title", hidden: true }, [
    h("header", null, [titleEl, closeBtn]),
    log,
    status,
    prechat,
    composer,
  ]);
  var badge = h("span", { class: "badge", hidden: true, "aria-hidden": "true" });
  var bubbleIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  bubbleIcon.setAttribute("viewBox", "0 0 24 24");
  bubbleIcon.setAttribute("aria-hidden", "true");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 5h16v11H8l-4 4V5z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  bubbleIcon.appendChild(path);
  var launch = h("button", { class: "launch", type: "button", "aria-label": L.open, "aria-expanded": "false", "aria-controls": panelId }, [bubbleIcon, badge]);
  root.appendChild(panel);
  root.appendChild(launch);

  // ── State ───────────────────────────────────────────────────────────────
  var config = null;
  var byId = {}; // server id → row element
  var lastAt = null; // newest server time seen
  var hasConversation = false;
  var unread = 0;
  var seenAt = store(SEEN_KEY) || "";
  var channel = null;

  function isOpen() {
    return !panel.hidden;
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function setUnread(n) {
    unread = n;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
    launch.setAttribute("aria-label", n ? L.open + " (" + L.unread(n) + ")" : L.open);
  }

  function markSeen(at) {
    if (at && at > seenAt) {
      seenAt = at;
      store(SEEN_KEY, at);
    }
  }

  function mediaNode(m, kind) {
    var url = m && safeUrl(m.url);
    if (!url) return null;
    var mime = String(m.mime || "");
    if (kind === "sticker") return h("img", { class: "sticker", src: url, alt: "Sticker", loading: "lazy" });
    if (kind === "image" || mime.indexOf("image/") === 0) return h("img", { src: url, alt: m.filename || "Image", loading: "lazy" });
    if (kind === "video" || mime.indexOf("video/") === 0) return h("video", { src: url, controls: true, preload: "metadata" });
    if (kind === "audio" || kind === "voice" || mime.indexOf("audio/") === 0) return h("audio", { src: url, controls: true, preload: "metadata" });
    return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", download: m.filename || true, text: m.filename || L.file });
  }

  /** The choice the visitor made on an interactive message: the row keeps it pressed. */
  function choose(row, button, reply) {
    var all = row.querySelectorAll(".choices button");
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    button.setAttribute("aria-pressed", "true");
    send({ reply: reply });
  }

  function interactiveNode(row, it) {
    if (!it || typeof it !== "object") return null;
    var wrap = h("div", { class: "choices", role: "group", "aria-label": L.options });
    if (it.type === "buttons" && Array.isArray(it.buttons)) {
      it.buttons.slice(0, 10).forEach(function (b) {
        var btn = h("button", { type: "button", "aria-pressed": "false", text: String(b.title || "") });
        btn.addEventListener("click", function () {
          choose(row, btn, { id: String(b.id || b.title), title: String(b.title || "").slice(0, 100) });
        });
        wrap.appendChild(btn);
      });
      return wrap;
    }
    if (it.type === "list" && Array.isArray(it.sections)) {
      var list = h("div", { class: "list", hidden: true });
      var toggle = h("button", { type: "button", "aria-expanded": "false", text: String(it.button || L.options) });
      toggle.addEventListener("click", function () {
        list.hidden = !list.hidden;
        toggle.setAttribute("aria-expanded", String(!list.hidden));
      });
      it.sections.forEach(function (s) {
        if (s.title) list.appendChild(h("div", { class: "section", text: String(s.title) }));
        (s.rows || []).forEach(function (r) {
          var btn = h("button", { type: "button", "aria-pressed": "false" }, [document.createTextNode(String(r.title || "")), r.description ? h("small", { text: String(r.description) }) : null]);
          btn.addEventListener("click", function () {
            choose(row, btn, { id: String(r.id || r.title), title: String(r.title || "").slice(0, 100) });
          });
          list.appendChild(btn);
        });
      });
      wrap.appendChild(toggle);
      wrap.appendChild(list);
      return wrap;
    }
    if (it.type === "url") {
      var href = safeUrl(it.url);
      if (!href) return null;
      wrap.appendChild(h("a", { href: href, target: "_blank", rel: "noopener noreferrer", text: String(it.text || href) }));
      return wrap;
    }
    return null;
  }

  /** One message: `in` is the visitor (right), `out` is the business (left). */
  function render(m) {
    var mine = m.direction === "in";
    var row = h("div", { class: "row " + (mine ? "me" : "them") });
    var label = h("span", { class: "sr", text: (mine ? L.you : L.them) + ": " });
    var bubble = h("div", { class: "bubble" }, [label]);
    var media = m.media ? mediaNode(m.media, m.kind) : null;
    if (media) bubble.appendChild(media);
    var text = m.body || (m.interactive && m.interactive.body) || "";
    if (m.kind === "reaction") text = m.body || "";
    if (text) bubble.appendChild(document.createTextNode((media ? "\n" : "") + text));
    if (media || text) row.appendChild(bubble);
    if (!mine && m.interactive) {
      var it = interactiveNode(row, m.interactive);
      if (it) row.appendChild(it);
    }
    return row;
  }

  function upsert(m) {
    if (!m || !m.id || byId[m.id]) return;
    var row = render(m);
    byId[m.id] = row;
    log.appendChild(row);
    hasConversation = true;
    if (m.at && (!lastAt || m.at > lastAt)) lastAt = m.at;
    if (m.direction === "out") {
      if (isOpen() && !document.hidden) markSeen(m.at);
      else if (!m.at || m.at > seenAt) setUnread(unread + 1);
    }
    scrollDown();
  }

  // ── Talking to the API ──────────────────────────────────────────────────
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function pendingRow(text) {
    var row = h("div", { class: "row me" }, [h("div", { class: "bubble" }, [h("span", { class: "sr", text: L.you + ": " }), document.createTextNode(text)])]);
    var meta = h("div", { class: "meta", text: L.sending });
    row.appendChild(meta);
    log.appendChild(row);
    scrollDown();
    return { row: row, meta: meta };
  }

  function send(what) {
    var text = what.text || (what.reply && what.reply.title) || "";
    var clientMessageId = randomHex(12);
    // A reply to a button shows on the button itself; text gets its own bubble.
    var local = what.text ? pendingRow(text) : null;
    deliver(what, clientMessageId, local, 0);
  }

  function deliver(what, clientMessageId, local, attempt) {
    var body = { visitorId: visitorId, clientMessageId: clientMessageId };
    if (what.text) body.text = what.text;
    if (what.reply) body.reply = what.reply;
    if (profile && !profile.sent) {
      if (profile.name) body.name = profile.name;
      if (profile.email) body.email = profile.email;
    }
    api("POST", CHAT + "/messages", body)
      .then(function (res) {
        var d = res && res.data ? res.data : {};
        status.textContent = "";
        if (profile && !profile.sent) {
          profile.sent = true;
          store(PROFILE_KEY, JSON.stringify(profile));
        }
        if (local) {
          if (d.id) byId[d.id] = local.row;
          local.meta.remove();
        }
        if (d.at && (!lastAt || d.at > lastAt)) lastAt = d.at;
        hasConversation = true;
        if (d.channel) listen(d.channel);
        schedule(1500);
      })
      .catch(function (err) {
        // The same clientMessageId: a retry is the same message, never a second one.
        if (!err.status && attempt < 2) {
          window.setTimeout(function () {
            deliver(what, clientMessageId, local, attempt + 1);
          }, 1500 * (attempt + 1));
          return;
        }
        if (err.status === 429) status.textContent = L.tooMany;
        if (local) {
          local.meta.textContent = L.failed;
          var again = h("button", { type: "button", text: L.retry });
          again.addEventListener("click", function () {
            local.meta.textContent = L.sending;
            deliver(what, clientMessageId, local, 0);
          });
          local.meta.appendChild(again);
        }
      });
  }

  // ── New answers: realtime first, polling always as the floor ────────────
  var socket = null;
  var socketOpen = false;
  var socketTries = 0;
  var pingTimer = 0;

  function listen(name) {
    if (!name || channel === name) return;
    channel = name;
    connect();
  }

  function connect() {
    if (!channel || socket || socketTries > 6 || !("WebSocket" in window)) return;
    try {
      socket = new WebSocket(REALTIME);
    } catch (e) {
      socket = null;
      return;
    }
    socket.onopen = function () {
      socketOpen = true;
      socketTries = 0;
      socket.send(JSON.stringify({ type: "subscribe", channel: channel }));
      pingTimer = window.setInterval(function () {
        if (socket && socketOpen) socket.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };
    socket.onmessage = function (ev) {
      var frame;
      try {
        frame = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (frame && frame.type === "message" && frame.channel === channel && frame.data && frame.data.type === "message") upsert(frame.data);
    };
    socket.onclose = function () {
      socket = null;
      socketOpen = false;
      window.clearInterval(pingTimer);
      socketTries++;
      // A site the API does not list cannot open the socket: after a few tries polling carries on alone.
      if (socketTries <= 6) window.setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, socketTries)) + Math.random() * 1000);
    };
    socket.onerror = function () {
      /* onclose follows */
    };
  }

  var pollTimer = 0;
  var failures = 0;

  function interval() {
    if (!hasConversation) return 0;
    if (document.hidden) return 60000;
    if (socketOpen) return 30000;
    return isOpen() ? 4000 : 15000;
  }

  function schedule(ms) {
    window.clearTimeout(pollTimer);
    var wait = ms !== undefined ? ms : interval();
    if (!wait) return;
    pollTimer = window.setTimeout(poll, Math.min(120000, wait * Math.pow(2, failures)));
  }

  function poll() {
    // A little before the newest seen: an answer written earlier may be delivered later. Ids dedupe.
    var after = lastAt ? new Date(new Date(lastAt).getTime() - 120000).toISOString() : null;
    var url = CHAT + "/messages?visitorId=" + encodeURIComponent(visitorId) + (after ? "&after=" + encodeURIComponent(after) : "");
    api("GET", url)
      .then(function (res) {
        failures = 0;
        (res.data || []).forEach(upsert);
        if (res.channel) listen(res.channel);
      })
      .catch(function () {
        failures = Math.min(failures + 1, 4);
      })
      .then(function () {
        schedule();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && hasConversation) schedule(200);
  });

  // ── Opening, closing, writing ───────────────────────────────────────────
  var started = false;

  function needsPrechat() {
    return !!(config && config.preChatForm) && !(profile && profile.name) && !hasConversation;
  }

  function showComposer() {
    var pre = needsPrechat();
    prechat.hidden = !pre;
    composer.hidden = pre;
  }

  function openPanel() {
    panel.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    launch.setAttribute("aria-label", L.close);
    setUnread(0);
    if (lastAt) markSeen(lastAt);
    showComposer();
    window.setTimeout(function () {
      (prechat.hidden ? input : nameIn).focus();
    }, 0);
    scrollDown();
    schedule(300);
  }

  function closePanel() {
    panel.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    setUnread(0);
    launch.focus();
  }

  launch.addEventListener("click", function () {
    if (isOpen()) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
  });

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(120, input.scrollHeight) + "px";
  }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit ? composer.requestSubmit() : composer.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  composer.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    send({ text: text });
  });
  prechat.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = nameIn.value.trim();
    if (!name) {
      nameIn.focus();
      return;
    }
    var email = emailIn.value.trim();
    if (email && !emailIn.checkValidity()) {
      emailIn.reportValidity();
      return;
    }
    profile = { name: name, email: email || undefined, sent: false };
    store(PROFILE_KEY, JSON.stringify(profile));
    showComposer();
    input.focus();
  });

  function start() {
    if (started) return;
    started = true;
    api("GET", CHAT + "/config")
      .then(function (res) {
        config = (res && res.data) || {};
        if (config.name) {
          titleEl.textContent = String(config.name);
          log.setAttribute("aria-label", String(config.name));
        }
        if (config.greeting) log.appendChild(render({ direction: "out", kind: "text", body: String(config.greeting) }));
        (document.body || document.documentElement).appendChild(host);
        if (script.dataset.open === "true") openPanel();
        // The visitor's earlier conversation, if this browser has one.
        return api("GET", CHAT + "/messages?visitorId=" + encodeURIComponent(visitorId)).then(function (h2) {
          (h2.data || []).forEach(upsert);
          if (h2.channel && (h2.data || []).length) listen(h2.channel);
          showComposer();
          schedule();
        });
      })
      .catch(function () {
        /* an unknown, disabled or not-for-this-site chat: nothing is shown */
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
