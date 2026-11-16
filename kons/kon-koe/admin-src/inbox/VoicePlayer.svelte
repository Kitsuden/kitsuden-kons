<!--
  A voice note: play/pause, its waveform (when the media converter measured one) as a seek bar, and the time.
  It plays the browser-playable copy when there is one (an OGG/Opus note does not play everywhere), and
  offers the file itself when the browser cannot play either.
-->
<script lang="ts">
  import type { MediaView } from "../types";
  import { duration } from "./format";
  import { T } from "./strings";

  const { media, mine = false }: { media: MediaView; mine?: boolean } = $props();

  let audio = $state<HTMLAudioElement>();
  let playing = $state(false);
  let current = $state(0);
  let total = $state(0);
  let broken = $state(false);

  const src = $derived(media.playableUrl ?? media.url ?? "");
  const length = $derived(total || (media.durationMs ?? 0) / 1000);

  /** 48 bars from whatever resolution the converter gave, scaled to the loudest. */
  const bars = $derived.by(() => {
    const w = media.waveform ?? [];
    if (!w.length) return [] as number[];
    const n = 48;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i * w.length) / n);
      const to = Math.max(from + 1, Math.floor(((i + 1) * w.length) / n));
      let peak = 0;
      for (let j = from; j < to && j < w.length; j++) peak = Math.max(peak, Math.abs(Number(w[j]) || 0));
      out.push(peak);
    }
    const max = Math.max(...out, 1e-6);
    return out.map((v) => Math.max(0.08, v / max));
  });

  const progress = $derived(length ? current / length : 0);

  function toggle() {
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => (broken = true));
    else audio.pause();
  }

  function seek(fraction: number) {
    if (!audio || !length) return;
    audio.currentTime = Math.max(0, Math.min(length, fraction * length));
    current = audio.currentTime;
  }

  function onKey(e: KeyboardEvent) {
    if (!audio || !length) return;
    if (e.key === "ArrowRight") seek((current + 5) / length);
    else if (e.key === "ArrowLeft") seek((current - 5) / length);
    else return;
    e.preventDefault();
  }
</script>

{#if !src}
  <span class="dim">{media.status === "failed" ? T.mediaFailed : T.mediaPending}</span>
{:else if broken}
  <a class="file" href={media.url ?? src} target="_blank" rel="noopener noreferrer">{T.openFile}</a>
{:else}
  <div class="voice" class:mine>
    <audio
      bind:this={audio}
      {src}
      preload="metadata"
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      onended={() => {
        playing = false;
        current = 0;
      }}
      ontimeupdate={() => (current = audio?.currentTime ?? 0)}
      onloadedmetadata={() => {
        const d = audio?.duration ?? 0;
        if (Number.isFinite(d) && d > 0) total = d;
      }}
      onerror={() => (broken = true)}
    ></audio>
    <button type="button" class="play" aria-label={playing ? T.pause : T.play} onclick={toggle}>
      {#if playing}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" /></svg>
      {:else}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor" /></svg>
      {/if}
    </button>
    {#if bars.length}
      <div
        class="wave"
        role="slider"
        tabindex="0"
        aria-label={T.play}
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${duration(current * 1000)} / ${duration(length * 1000)}`}
        onkeydown={onKey}
        onclick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        {#each bars as b, i (i)}
          <span class="bar" class:played={i / bars.length < progress} style:height={`${Math.round(b * 100)}%`}></span>
        {/each}
      </div>
    {:else}
      <input
        class="range"
        type="range"
        min="0"
        max={Math.max(1, Math.round(length))}
        step="0.1"
        value={current}
        aria-label={T.play}
        oninput={(e) => seek(Number((e.currentTarget as HTMLInputElement).value) / Math.max(1, length))}
      />
    {/if}
    <span class="time">{duration((playing || current ? current : length) * 1000)}</span>
  </div>
  {#if media.transcript}
    <details class="transcript">
      <summary>{T.transcript}</summary>
      <p>{media.transcript}</p>
    </details>
  {/if}
{/if}

<style>
  .voice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 13rem;
  }

  .play {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: var(--ta-accent-fill, rgb(var(--ta-accent)));
    color: rgb(var(--ta-on-accent));
    cursor: pointer;
  }

  .mine .play {
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text));
  }

  .play:focus-visible,
  .wave:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: 2px;
  }

  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    height: 1.75rem;
    cursor: pointer;
  }

  .bar {
    flex: 1;
    min-width: 2px;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.35;
  }

  .bar.played {
    opacity: 1;
  }

  .range {
    flex: 1;
    accent-color: rgb(var(--ta-accent));
  }

  .time {
    flex-shrink: 0;
    min-width: 2.5rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .transcript {
    margin-top: 0.25rem;
    font-size: 0.8125rem;
  }

  .transcript p {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
  }

  .dim {
    font-size: 0.8125rem;
    opacity: 0.75;
  }

  .file {
    color: inherit;
  }
</style>
