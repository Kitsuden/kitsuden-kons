/**
 * Web push for the inbox: the service worker (GET <koe>/sw.js) and this browser's subscription.
 *
 * koe sends payload-less pushes signed with its VAPID key (koe.notify.ts); `GET /me` gives the public half
 * (`pushKey`). The subscription is stored with POST /push/subscriptions and removed with
 * POST /push/unsubscribe. The worker shows the newest notice and opens the conversation on a click.
 */

import type { Api } from "../api";

export type PushState = "unsupported" | "denied" | "off" | "on";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;

/** The worker's URL and scope: the kon's base, where the inbox page lives. */
function worker(base: string): { url: string; scope: string } {
  const abs = new URL(base.replace(/\/+$/, ""), window.location.href);
  return { url: `${abs.pathname}/sw.js`, scope: `${abs.pathname}/` };
}

async function registration(base: string): Promise<ServiceWorkerRegistration> {
  const { url, scope } = worker(base);
  const existing = await navigator.serviceWorker.getRegistration(scope);
  if (existing) return existing;
  return navigator.serviceWorker.register(url, { scope });
}

export async function pushState(base: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration(worker(base).scope);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch {
    return "off";
  }
}

/** The VAPID public key (base64url) as PushManager wants it. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const b64 = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined);

export async function enablePush(base: string, api: Api, pushKey: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration(base);
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
  await api.post("push/subscriptions", {
    endpoint: sub.endpoint,
    keys: { p256dh: b64(sub.getKey("p256dh")), auth: b64(sub.getKey("auth")) },
    userAgent: navigator.userAgent.slice(0, 300),
  });
  return "on";
}

export async function disablePush(base: string, api: Api): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration(worker(base).scope);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api.post("push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return "off";
}

/** Clicks on a notification while the inbox is open arrive here: `{ type: "koe:open", conversationId }`. */
export function onWorkerMessage(handler: (conversationId: string | null) => void): () => void {
  if (!pushSupported()) return () => {};
  const listener = (ev: MessageEvent) => {
    const d = ev.data as { type?: string; conversationId?: string | null } | null;
    if (d?.type === "koe:open") handler(d.conversationId ?? null);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
