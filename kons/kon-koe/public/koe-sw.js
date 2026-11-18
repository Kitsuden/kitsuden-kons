/*
 * koe's service worker: web push for the inbox.
 *
 * Served by GET <koe>/sw.js (koe.ops.web.ts) and registered by the inbox with that URL, so its scope is
 * the kon's path (`/api/koe/`), which holds the inbox page.
 *
 * A koe push carries NO payload (koe.notify.ts): it is an empty signed "tickle". On a push this worker
 * asks GET <koe>/notices/latest with the person's session cookie and shows that notice. Nothing about a
 * conversation passes through the browser vendor's push service. A click focuses an open inbox (and
 * tells it which conversation to open) or opens <koe>/inbox#<conversationId>.
 *
 * Plain script, no imports, no eval: it runs under the page's CSP and the browser's worker rules.
 */
/* eslint-env serviceworker */
"use strict";

// "/api/koe/sw.js" → "/api/koe": the kon's base, wherever it is mounted.
var KOE_BASE = self.location.pathname.replace(/\/sw\.js$/, "");
var INBOX = KOE_BASE + "/inbox";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function latestNotice() {
  return fetch(KOE_BASE + "/notices/latest", { credentials: "include", cache: "no-store", headers: { accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (body) {
        return body && body.data ? body.data : null;
      });
    })
    .catch(function () {
      return null;
    });
}

self.addEventListener("push", function (event) {
  event.waitUntil(
    latestNotice().then(function (notice) {
      // A push must show something (userVisibleOnly). Without a readable notice (signed out, already
      // read in another tab), a neutral line that still leads to the inbox.
      var title = notice && notice.title ? String(notice.title).slice(0, 200) : "koe";
      var body = notice && notice.body ? String(notice.body).slice(0, 300) : notice ? "" : "Something new in the inbox";
      var conversationId = notice && notice.conversationId ? String(notice.conversationId) : null;
      return self.registration.showNotification(title, {
        body: body,
        tag: conversationId ? "koe-conversation-" + conversationId : "koe",
        renotify: !!notice,
        data: { conversationId: conversationId, noticeId: notice && notice.id ? String(notice.id) : null },
      });
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var conversationId = data.conversationId ? String(data.conversationId) : "";
  var target = new URL(INBOX + (conversationId ? "#" + encodeURIComponent(conversationId) : ""), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (new URL(w.url).pathname === INBOX && "focus" in w) {
          w.postMessage({ type: "koe:open", conversationId: conversationId || null, noticeId: data.noticeId || null });
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
