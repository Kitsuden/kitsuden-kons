/**
 * The moderation queue's state: the list on screen, the counts per state and what is marked for
 * the batch. Results of actions go to the toast (ui/notify.ts); a failed load is the list's own
 * state, with Retry.
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
import { createLoad, type Load } from "./ui/load.svelte";
import { failed, toast } from "./ui/notify";

export const STATUSES: { id: Status; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "published", label: "Published" },
  { id: "hidden", label: "Hidden" },
];

/** What a moderation did, for the toast. */
const DONE: Record<Status, string> = { pending: "Returned to pending", published: "Approved", hidden: "Hidden" };

export class Queue {
  status = $state<Status>("pending");
  rows = $state<QueueRow[]>([]);
  counts = $state<Partial<Record<Status, number>>>({});
  /** Ids marked for the batch. */
  marked = new SvelteSet<string>();
  busy = $state(false);
  /** Another queue was asked for: its rows are not here yet, and the last queue's are not its own. */
  switching = $state(false);

  /** Answers to an older request (a tab clicked twice in a row) are dropped. */
  private ticket = 0;

  private readonly data = createLoad(async () => {
    const ticket = ++this.ticket;
    try {
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
      if (e instanceof ApiError && e.status === 403) {
        throw new Error("Your account does not have moderation permission. An admin or editor role is required.");
      }
      throw e;
    } finally {
      if (ticket === this.ticket) this.switching = false;
    }
  });

  /** What the list draws around its rows: loading, failed with Retry, or ready. */
  readonly state: Load;

  constructor(readonly api: Api) {
    const data = this.data;
    const switching = () => this.switching && data.status === "ready";
    this.state = {
      load: data.load,
      get status() {
        return switching() ? "loading" : data.status;
      },
      get loading() {
        return data.loading || switching();
      },
      get ready() {
        return data.ready && !switching();
      },
      get error() {
        return data.error;
      },
      get retrying() {
        return data.retrying;
      },
    };
  }

  load() {
    return this.data.load();
  }

  show(status: Status) {
    this.status = status;
    this.rows = [];
    this.marked.clear();
    this.switching = true;
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
      await this.api.post(`${encodeURIComponent(id)}/moderate`, { status });
      toast.success(DONE[status]);
      await this.load();
    } catch (e) {
      failed("Could not moderate the comment", e);
    } finally {
      this.busy = false;
    }
  }

  async bulk(status: Status) {
    const ids = [...this.marked];
    if (ids.length === 0) return;
    this.busy = true;
    try {
      const r = await this.api.post<BulkResponse>("moderation/bulk", { ids, status });
      await this.load();
      // It shows what the server says was touched, not what was requested. If the list was out
      // of date and some no longer exist, saying "20 moderated" when it was 18 means nobody
      // finds out.
      if (r.moderated === r.requested) toast.success(`${DONE[status]}: ${r.moderated}`);
      else {
        toast.success(`${DONE[status]}: ${r.moderated} of ${r.requested}`, { description: "The rest were already gone." });
      }
    } catch (e) {
      failed("Could not moderate the selection", e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Throws on failure, so the confirmation stays open. Answers whether the server hid the comment
   * instead of deleting it (it does when the comment has replies).
   */
  async remove(id: string) {
    const r = await this.api.del<{ hidden?: boolean } | null>(encodeURIComponent(id));
    await this.load();
    return r?.hidden === true;
  }
}
