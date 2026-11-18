/**
 * The state of something a section loads: loading, ready or failed, with the message and a
 * retry. The section keeps its own data; this only says which of the three it is, so every
 * list draws a skeleton while it loads and an error with Retry when the API fails, never
 * "nothing here".
 *
 *   const data = createLoad(async () => { rows = (await api.get("things")).data; });
 *   $effect(() => { untrack(data.load); });
 *
 * A reload after an action (`await data.load()`) keeps the rows on screen: only the first load,
 * and a retry after a failure, show the loading state.
 */
export type LoadStatus = "loading" | "ready" | "error";

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createLoad(run: () => Promise<void>) {
  let status = $state<LoadStatus>("loading");
  let error = $state("");
  let retrying = $state(false);
  let turn = 0;

  async function load() {
    const mine = ++turn;
    if (status === "error") retrying = true;
    try {
      await run();
      if (mine !== turn) return;
      status = "ready";
      error = "";
    } catch (e) {
      if (mine !== turn) return;
      status = "error";
      error = message(e);
    } finally {
      if (mine === turn) retrying = false;
    }
  }

  return {
    load,
    get status() {
      return status;
    },
    get loading() {
      return status === "loading";
    },
    get ready() {
      return status === "ready";
    },
    /** The message of a failed load, or null: what DataTable's `error` takes. */
    get error() {
      return status === "error" ? error : null;
    },
    get retrying() {
      return retrying;
    },
  };
}

export type Load = ReturnType<typeof createLoad>;
