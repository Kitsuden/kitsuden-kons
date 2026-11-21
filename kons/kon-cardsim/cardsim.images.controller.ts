/**
 * The "My images" state, without a UI
 * ============================================================================
 *
 * Everything the board's image panel does, as a plain object: the player's sources in order, the
 * local ones this browser has open, saving through the kon, and feeding the resolver. The Svelte
 * board renders it; another renderer (a WebGL table, an engine like Estella) can drive the same
 * object and get the same images.
 *
 * Settings go to the kon (`createPrefsStore`); images stay here (`createImageResolver`).
 */

import { urlProblem, type ImageSource } from "./cardsim.images.js";
import {
  canPickFolders,
  createImageResolver,
  createPrefsStore,
  folderFromFiles,
  folderFromHandle,
  forgetFolderHandle,
  loadFolderHandles,
  pickFolder,
  reopenFolder,
  requestPersistentStorage,
  runtimesFromSources,
  saveFolderHandle,
  zipSource,
  loadPack,
  type DirectoryHandleLike,
  type Fetcher,
  type ImageCache,
  type ImageProcessor,
  type ImageResolver,
  type SourceRuntime,
} from "./cardsim.images.client.js";

export interface ImagesControllerOptions {
  game: string;
  cache: ImageCache;
  /** The kon's base URL, to keep the settings in the player's account. */
  apiBase?: string;
  fetcher?: Fetcher;
  processor?: ImageProcessor;
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Sources the SITE adds after the player's (hosted images). Never saved. */
  trailing?: SourceRuntime[];
  /** Whether to look for kept folder handles (off in tests). */
  folderHandles?: boolean;
}

export interface ImagesState {
  sources: ImageSource[];
  /** `kind:label` of the local sources open in this browser right now. */
  open: Set<string>;
  /** `label`s of kept folders that need a click to be read again. */
  closedFolders: Set<string>;
  synced: boolean;
  error: string | null;
  usage: { count: number; bytes: number };
}

export const localId = (s: { kind: string; label: string }) => `${s.kind}:${s.label}`;

/** A label not used yet: "scans", "scans (2)"… */
function uniqueLabel(wanted: string, sources: ImageSource[]): string {
  const base = wanted.trim().slice(0, 70) || "source";
  const used = new Set(sources.map((s) => s.label));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} (${i})`)) return `${base} (${i})`;
}

/** "card | https://…" lines into a map; returns the bad lines too. */
export function parseCardUrls(text: string): { urls: Record<string, string>; bad: number[] } {
  const urls: Record<string, string> = {};
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cut = line.lastIndexOf("|");
    const key = cut > 0 ? line.slice(0, cut).trim() : "";
    const url = cut > 0 ? line.slice(cut + 1).trim() : "";
    if (!key || urlProblem(url)) bad.push(i + 1);
    else urls[key] = url;
  });
  return { urls, bad };
}

export function createImagesController(options: ImagesControllerOptions) {
  const fetcher: Fetcher = options.fetcher ?? ((u, i) => fetch(u, i));
  const prefs = createPrefsStore({
    game: options.game,
    apiBase: options.apiBase,
    fetcher,
    storage: options.storage,
  });
  const resolver: ImageResolver = createImageResolver({
    game: options.game,
    cache: options.cache,
    processor: options.processor,
  });

  const local = new Map<string, SourceRuntime>();
  const keptFolders = new Map<string, DirectoryHandleLike>();
  const listeners = new Set<(s: ImagesState) => void>();

  let state: ImagesState = {
    sources: [],
    open: new Set(),
    closedFolders: new Set(),
    synced: false,
    error: null,
    usage: { count: 0, bytes: 0 },
  };

  function emit(patch: Partial<ImagesState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  }

  function wire() {
    const { runtimes } = runtimesFromSources(state.sources, { fetcher, game: options.game, local });
    resolver.setSources([...runtimes, ...(options.trailing ?? [])]);
  }

  async function refreshUsage() {
    emit({ usage: await resolver.usage().catch(() => ({ count: 0, bytes: 0 })) });
  }

  async function commit(sources: ImageSource[]) {
    const saved = await prefs.save(sources);
    if (saved.error) {
      emit({ error: saved.error });
      return false;
    }
    emit({ sources: saved.sources, synced: saved.synced, error: null });
    wire();
    return true;
  }

  function openLocal(runtime: SourceRuntime) {
    local.set(localId(runtime), runtime);
    emit({ open: new Set(local.keys()) });
  }

  return {
    resolver,
    get state() {
      return state;
    },
    subscribe(listener: (s: ImagesState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    /** Loads the settings (from the account when there is one) and reopens kept folders. */
    async load() {
      const loaded = await prefs.load();
      const closed = new Set<string>();
      if (options.folderHandles !== false) {
        for (const { label, handle } of await loadFolderHandles(options.game)) {
          keptFolders.set(label, handle);
          const granted = (await handle.queryPermission?.({ mode: "read" }).catch(() => "denied")) === "granted";
          if (granted) openLocal(await folderFromHandle(label, handle));
          else closed.add(label);
        }
      }
      emit({ sources: loaded.sources, synced: loaded.synced, closedFolders: closed });
      wire();
      await refreshUsage();
    },

    /** A folder: the picker where the browser has one (kept for next visit), else a file list. */
    canPickFolders,
    async addFolderFromPicker() {
      const handle = await pickFolder();
      if (!handle) return false;
      const label = uniqueLabel(handle.name, state.sources);
      await saveFolderHandle(options.game, label, handle);
      keptFolders.set(label, handle);
      openLocal(await folderFromHandle(label, handle));
      return commit([...state.sources, { kind: "folder", label, enabled: true }]);
    },
    async addFolderFromFiles(files: ArrayLike<File>) {
      if (!files.length) return false;
      const first = files[0] as File & { webkitRelativePath?: string };
      const label = uniqueLabel(first.webkitRelativePath?.split("/")[0] || "folder", state.sources);
      openLocal(folderFromFiles(label, files));
      return commit([...state.sources, { kind: "folder", label, enabled: true }]);
    },
    async addZip(file: File) {
      const label = uniqueLabel(file.name, state.sources);
      try {
        openLocal(await zipSource(label, file));
      } catch {
        emit({ error: "zip" });
        return false;
      }
      return commit([...state.sources, { kind: "zip", label, enabled: true }]);
    },
    async addTemplate(label: string, url: string) {
      return commit([
        ...state.sources,
        { kind: "template", label: uniqueLabel(label || "template", state.sources), url, enabled: true },
      ]);
    },
    async addCardUrls(label: string, text: string) {
      const { urls, bad } = parseCardUrls(text);
      if (bad.length) {
        emit({ error: `lines: ${bad.join(", ")}` });
        return false;
      }
      return commit([
        ...state.sources,
        { kind: "cardUrls", label: uniqueLabel(label || "links", state.sources), urls, enabled: true },
      ]);
    },
    /** Checks the pack before saving it, so a wrong link is told now and not on every card. */
    async addPack(label: string, url: string) {
      try {
        const pack = await loadPack(url, fetcher, options.game);
        return commit([
          ...state.sources,
          { kind: "pack", label: uniqueLabel(label || pack.name, state.sources), url, enabled: true },
        ]);
      } catch (e) {
        emit({ error: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },

    async remove(index: number) {
      const removed = state.sources[index];
      if (!removed) return false;
      if (removed.kind === "folder") {
        await forgetFolderHandle(options.game, removed.label);
        keptFolders.delete(removed.label);
      }
      local.delete(localId(removed));
      emit({ open: new Set(local.keys()) });
      return commit(state.sources.filter((_, i) => i !== index));
    },
    async move(index: number, by: -1 | 1) {
      const to = index + by;
      if (to < 0 || to >= state.sources.length) return false;
      const next = [...state.sources];
      [next[index], next[to]] = [next[to], next[index]];
      return commit(next);
    },
    async toggle(index: number) {
      const next = state.sources.map((s, i) => (i === index ? { ...s, enabled: s.enabled === false } : s));
      return commit(next);
    },
    /** A kept folder, read again (must run from a click: the browser may ask). */
    async reopen(label: string) {
      const handle = keptFolders.get(label);
      if (!handle || !(await reopenFolder(handle))) return false;
      openLocal(await folderFromHandle(label, handle));
      const closed = new Set(state.closedFolders);
      closed.delete(label);
      emit({ closedFolders: closed });
      wire();
      return true;
    },

    async clearCache() {
      await resolver.clearCache();
      await refreshUsage();
    },
    persist: requestPersistentStorage,
    refreshUsage,
    clearError() {
      emit({ error: null });
    },
    dispose() {
      resolver.dispose();
      listeners.clear();
    },
  };
}

export type ImagesController = ReturnType<typeof createImagesController>;
