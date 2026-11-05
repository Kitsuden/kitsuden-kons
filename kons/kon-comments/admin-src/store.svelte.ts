/**
 * The moderation queue's state: the list on screen, the counts per state, what is marked for the
 * batch and the last error.
 *
 * Three decisions that are not about style:
 *
 *   · **Each row says which article it comes from.** The same text can be a legitimate reply in
 *     one thread and spam in another. Without that column — WordPress's "In response to" —
 *     moderating is guessing.
 *   · **Hide, do not delete.** A removed comment stays in the tree with its body replaced,
 *     because deleting it takes its replies along. Real deletion exists, but asks for
 *     confirmation and says what it takes with it.
 *   · **Batch actions.** A spam streak arrives all at once; one by one is twenty requests and
 *     twenty chances to click the wrong thing.
 */
import { SvelteSet } from "svelte/reactivity";

import { ApiError, type Api } from "./api";
import type { BulkResponse, QueueResponse, QueueRow, Status } from "./types";

export const STATUSES: { id: Status; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "published", label: "Published" },
  { id: "hidden", label: "Hidden" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Queue {
  status = $state<Status>("pending");
  rows = $state<QueueRow[]>([]);
  counts = $state<Partial<Record<Status, number>>>({});
  /** Ids marked for the batch. */
  marked = new SvelteSet<string>();
  error = $state<string | null>(null);
  /** What the last batch really touched. */
  outcome = $state<string | null>(null);
  loaded = $state(false);
  busy = $state(false);

  /** Answers to an older request (a tab clicked twice in a row) are dropped. */
  private ticket = 0;

  constructor(readonly api: Api) {}

  async load() {
    const ticket = ++this.ticket;
    try {
      this.error = null;
      const r = await this.api.get<QueueResponse>(
        `moderation/queue?status=${encodeURIComponent(this.status)}&limit=200`
      );
      if (ticket !== this.ticket) return;
      this.rows = r.data ?? [];
      this.counts = r.counts ?? {};
      // The selection is cleared when changing list: keeping it would make "Approve" act on
      // comments that are no longer on screen.
      this.marked.clear();
    } catch (e) {
      if (ticket !== this.ticket) return;
      // 403 is not a failure: it is "your account does not moderate". Saying it this way avoids
      // someone hunting for a fault that does not exist.
      this.error =
        e instanceof ApiError && e.status === 403
          ? "Your account does not have moderation permission. An admin or editor role is required."
          : message(e);
    } finally {
      if (ticket === this.ticket) this.loaded = true;
    }
  }

  show(status: Status) {
    this.status = status;
    void this.load();
  }

  toggle(id: string, on: boolean) {
    if (on) this.marked.add(id);
    else this.marked.delete(id);
  }

  toggleAll(on: boolean) {
    if (on) for (const r of this.rows) this.marked.add(r.id);
    else this.marked.clear();
  }

  async moderate(id: string, status: Status) {
    this.busy = true;
    try {
      this.error = null;
      await this.api.post(`${encodeURIComponent(id)}/moderate`, { status });
      await this.load();
    } catch (e) {
      this.error = message(e);
    } finally {
      this.busy = false;
    }
  }

  async bulk(status: Status) {
    const ids = [...this.marked];
    if (ids.length === 0) return;
    this.busy = true;
    try {
      this.error = null;
      const r = await this.api.post<BulkResponse>("moderation/bulk", { ids, status });
      // It shows what the server says was touched, not what was requested. If the list was out
      // of date and some no longer exist, saying "20 moderated" when it was 18 means nobody
      // finds out.
      await this.load();
      this.outcome =
        r.moderated === r.requested
          ? `${r.moderated} moderated`
          : `${r.moderated} of ${r.requested} — the rest were already gone`;
    } catch (e) {
      this.error = message(e);
    } finally {
      this.busy = false;
    }
  }

  /** Throws on failure, so the confirmation stays open with the error. */
  async remove(id: string) {
    await this.api.del(encodeURIComponent(id));
    await this.load();
  }
}
