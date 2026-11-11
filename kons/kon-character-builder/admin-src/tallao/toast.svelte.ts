/**
 * tallao — short-lived notifications (toasts)
 *
 *   import { toast } from "tallao";
 *   toast.success("Saved");
 *   toast.error("Could not save", { description: "The API returned 503" });
 *   const id = toast("Uploading…", { duration: Infinity });  toast.dismiss(id);
 *
 * They show up in whatever <Toaster /> is on the page (one is enough).
 */

export type ToastVariant = "default" | "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  description?: string;
  /** Milliseconds on screen; Infinity = until dismissed. Defaults to 5 s (8 s for an error). */
  duration?: number;
  action?: ToastAction;
}

export interface Toast extends ToastOptions {
  id: number;
  message: string;
  variant: ToastVariant;
}

let nextId = 1;

/** The open toasts; the Toaster reads them. */
export const toasts = $state<Toast[]>([]);

// On the server this module is shared by every request (SvelteKit): a toast stored here
// during a render would show up on another user's page. A toast is something that
// happens in the browser, so on the server toast() does nothing.
const onServer = typeof window === "undefined";

function show(variant: ToastVariant, message: string, opts: ToastOptions = {}): number {
  if (onServer) return 0;
  const t: Toast = { id: nextId++, message, variant, ...opts };
  t.duration ??= variant === "error" ? 8000 : 5000;
  toasts.push(t);
  return t.id;
}

function dismiss(id?: number) {
  if (id === undefined) toasts.splice(0, toasts.length);
  else {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }
}

type ToastFn = ((message: string, opts?: ToastOptions) => number) & {
  success: (message: string, opts?: ToastOptions) => number;
  error: (message: string, opts?: ToastOptions) => number;
  warning: (message: string, opts?: ToastOptions) => number;
  info: (message: string, opts?: ToastOptions) => number;
  /** Dismisses one, or all with no argument. */
  dismiss: (id?: number) => void;
};

export const toast: ToastFn = Object.assign((message: string, opts?: ToastOptions) => show("default", message, opts), {
  success: (m: string, o?: ToastOptions) => show("success", m, o),
  error: (m: string, o?: ToastOptions) => show("error", m, o),
  warning: (m: string, o?: ToastOptions) => show("warning", m, o),
  info: (m: string, o?: ToastOptions) => show("info", m, o),
  dismiss,
});
