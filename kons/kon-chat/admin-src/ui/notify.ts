/**
 * Every result of an action goes through the kit's toast: success in a line, a failure with the
 * API's message under what was being done. The view's root mounts the Toaster (ui/View.svelte).
 */
import { toast } from "$lib/toast.svelte";

import { message } from "./load.svelte";

export { toast };

/** `failed("Could not save the rules", e)`. */
export function failed(what: string, e: unknown) {
  toast.error(what, { description: message(e) });
}
