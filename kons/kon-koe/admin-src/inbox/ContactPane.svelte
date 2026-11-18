<!--
  Who the conversation is with: the contact's details (editable), consent per channel, the conversation's
  labels and priority, the team's notes, and their other conversations.
-->
<script lang="ts">
  import { Badge, Button, DescriptionList, Field, Input, Select, Skeleton, Switch } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import type { ContactDetail, Conversation } from "../types";
  import { clock, full, shortTime } from "./format";
  import type { Inbox } from "./store.svelte";
  import { T } from "./strings";

  const {
    inbox,
    onOpen,
    onWriteNote,
    onClose,
    onToast,
  }: {
    inbox: Inbox;
    onOpen: (id: string) => void;
    onWriteNote: () => void;
    onClose: () => void;
    onToast: (kind: "success" | "error" | "info", title: string, description?: string) => void;
  } = $props();

  const conv = $derived(inbox.current);
  const contactId = $derived(conv?.contactId ?? null);

  let contact = $state<ContactDetail | null>(null);
  let loading = $state(false);
  let editing = $state(false);
  let form = $state({ displayName: "", phone: "", email: "", locale: "" });
  let saving = $state(false);
  let newLabel = $state("");

  async function load(id: string) {
    loading = true;
    try {
      const c = (await inbox.api.get<{ data: ContactDetail }>(`contacts/${seg(id)}`)).data;
      if (id === contactId) contact = c;
    } catch {
      if (id === contactId) contact = null;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const id = contactId;
    editing = false;
    contact = null;
    if (id) untrack(() => load(id));
  });

  function edit() {
    if (!contact) return;
    form = { displayName: contact.displayName ?? "", phone: contact.phone ?? "", email: contact.email ?? "", locale: contact.locale ?? "" };
    editing = true;
  }

  async function save() {
    if (!contact) return;
    saving = true;
    try {
      await inbox.api.patch(`contacts/${seg(contact.id)}`, {
        displayName: form.displayName.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        locale: form.locale.trim() || null,
      });
      editing = false;
      onToast("success", T.saved);
      await load(contact.id);
      inbox.refreshList();
      void inbox.refreshConversation();
    } catch (e) {
      onToast("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    } finally {
      saving = false;
    }
  }

  async function setBlocked(blocked: boolean) {
    if (!contact) return;
    try {
      await inbox.api.patch(`contacts/${seg(contact.id)}`, { blocked });
      contact = { ...contact, blocked };
      onToast("success", blocked ? T.block : T.unblock);
    } catch (e) {
      onToast("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    }
  }

  async function consent(channelId: string, status: "opted_in" | "opted_out") {
    if (!contact) return;
    try {
      await inbox.api.put(`contacts/${seg(contact.id)}/consent`, { channelId, status, source: "inbox" });
      await load(contact.id);
      onToast("success", status === "opted_in" ? T.optedIn : T.optedOut);
    } catch (e) {
      onToast("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    }
  }

  async function labels(next: string[]) {
    try {
      await inbox.update({ labels: next });
    } catch (e) {
      onToast("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    }
  }

  async function priority(p: Conversation["priority"]) {
    try {
      await inbox.update({ priority: p });
    } catch (e) {
      onToast("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    }
  }

  function addLabel() {
    const l = newLabel.trim().slice(0, 60);
    if (!l || !conv || conv.labels.includes(l)) return;
    newLabel = "";
    void labels([...conv.labels, l]);
  }

  /** Each channel the contact is on, with its consent. */
  const consents = $derived(
    contact
      ? [...new Set(contact.identities.map((i) => i.channelId))].map((channelId) => ({
          channelId,
          channel: inbox.channelOf(channelId),
          consent: contact!.consents.find((c) => c.channelId === channelId) ?? null,
        }))
      : []
  );
  const others = $derived(contact ? contact.conversations.filter((c) => c.id !== conv?.id) : []);
</script>

<aside class="pane" aria-label={T.contactDetails}>
  <header class="head">
    <Button variant="ghost" size="icon" class="back" ariaLabel={T.back} onclick={onClose}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </Button>
    <h2>{T.contactDetails}</h2>
  </header>

  {#if !conv}
    <p class="dim pad">{T.pickConversation}</p>
  {:else}
    <div class="body">
      <section aria-labelledby="koe-contact">
        <div class="section-head">
          <h3 id="koe-contact">{T.contact}</h3>
          {#if contact && !editing}<Button size="sm" variant="ghost" onclick={edit}>{T.edit}</Button>{/if}
        </div>
        {#if loading && !contact}
          <Skeleton lines={3} />
        {:else if contact && editing}
          <form
            class="form"
            onsubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label={T.name}><Input bind:value={form.displayName} autocomplete="off" /></Field>
            <Field label={T.phone}><Input bind:value={form.phone} type="tel" autocomplete="off" /></Field>
            <Field label={T.email}><Input bind:value={form.email} type="email" autocomplete="off" /></Field>
            <Field label={T.locale}><Input bind:value={form.locale} autocomplete="off" placeholder="es-PE" /></Field>
            <div class="row">
              <Button size="sm" variant="ghost" onclick={() => (editing = false)}>{T.cancel}</Button>
              <Button size="sm" type="submit" loading={saving}>{T.save}</Button>
            </div>
          </form>
        {:else if contact}
          <DescriptionList
            layout="stacked"
            items={[
              { label: T.name, value: contact.displayName },
              { label: T.phone, value: contact.phone, copy: !!contact.phone },
              { label: T.email, value: contact.email, copy: !!contact.email },
              { label: T.locale, value: contact.locale },
            ]}
            emptyValue="—"
          />
          {#if contact.blocked}<Badge variant="error">{T.blocked}</Badge>{/if}
          {#if inbox.me?.lead}
            <Switch checked={contact.blocked} label={T.blocked} size="sm" onchange={(v: boolean) => setBlocked(v)} />
          {/if}
        {/if}
      </section>

      <section aria-labelledby="koe-conv">
        <h3 id="koe-conv">{T.conversation}</h3>
        <DescriptionList
          layout="stacked"
          items={[
            { label: T.channel, value: conv.channel ? `${conv.channel.name}${conv.channel.display ? ` · ${conv.channel.display}` : ""}` : "" },
            { label: T.team, value: inbox.teamName(conv.teamId) || T.noTeam },
            { label: T.assignee, value: conv.assigneeId ? inbox.nameOf(conv.assigneeId) : T.nobody },
          ]}
        />
        <Field label={T.priorityLabel}>
          <Select
            size="sm"
            value={conv.priority}
            onchange={(e: Event) => priority((e.currentTarget as HTMLSelectElement).value as Conversation["priority"])}
            options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: T.priority[p] ?? p }))}
          />
        </Field>
        <div class="labels" aria-label={T.labels} role="group">
          {#each conv.labels as l (l)}
            <span class="label">
              {l}
              <button type="button" aria-label={T.removeLabel(l)} onclick={() => labels(conv.labels.filter((x) => x !== l))}>×</button>
            </span>
          {/each}
          <form
            class="add-label"
            onsubmit={(e) => {
              e.preventDefault();
              addLabel();
            }}
          >
            <Input bind:value={newLabel} placeholder={T.addLabel} aria-label={T.addLabel} maxlength={60} autocomplete="off" />
          </form>
        </div>
      </section>

      {#if contact && consents.length}
        <section aria-labelledby="koe-consent">
          <h3 id="koe-consent">{T.consents}</h3>
          <ul class="plain">
            {#each consents as c (c.channelId)}
              <li class="consent">
                <span class="consent-name">{c.channel?.name ?? c.channelId}</span>
                {#if c.consent}
                  <Badge size="sm" variant={c.consent.status === "opted_in" ? "success" : "error"} title={`${c.consent.source} · ${full(c.consent.updatedAt)}`}>
                    {c.consent.status === "opted_in" ? T.optedIn : T.optedOut}
                  </Badge>
                {:else}
                  <Badge size="sm">{T.noConsent}</Badge>
                {/if}
                <span class="row">
                  {#if c.consent?.status !== "opted_in"}<Button size="sm" variant="ghost" onclick={() => consent(c.channelId, "opted_in")}>{T.optIn}</Button>{/if}
                  {#if c.consent?.status !== "opted_out"}<Button size="sm" variant="ghost" onclick={() => consent(c.channelId, "opted_out")}>{T.optOut}</Button>{/if}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section aria-labelledby="koe-notes">
        <div class="section-head">
          <h3 id="koe-notes">{T.notes}</h3>
          <Button size="sm" variant="ghost" onclick={onWriteNote}>{T.addNote}</Button>
        </div>
        {#if inbox.notes.length}
          <ul class="plain notes">
            {#each [...inbox.notes].reverse() as n (n.id)}
              <li class="note">
                <span class="note-head">{n.authorKind === "agent" ? inbox.nameOf(n.authorId) : T.authors[n.authorKind] ?? n.authorKind} · <time title={full(n.createdAt)}>{clock(n.createdAt)}</time></span>
                <p>{n.body}</p>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="dim">{T.noNotes}</p>
        {/if}
      </section>

      <section aria-labelledby="koe-others">
        <h3 id="koe-others">{T.otherConversations}</h3>
        {#if others.length}
          <ul class="plain">
            {#each others as o (o.id)}
              <li>
                <button type="button" class="other" onclick={() => onOpen(o.id)}>
                  <span class="other-top">
                    <span>{inbox.channelOf(o.channelId)?.name ?? ""}</span>
                    <Badge size="sm">{T.states[o.state] ?? o.state}</Badge>
                    <span class="dim">{shortTime(o.lastMessageAt ?? o.updatedAt, inbox.now)}</span>
                  </span>
                  <span class="dim other-preview">{o.lastMessagePreview ?? ""}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="dim">{T.none}</p>
        {/if}
      </section>
    </div>
  {/if}
</aside>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: rgb(var(--ta-surface));
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3.25rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgb(var(--ta-border));
  }

  .head h2 {
    margin: 0;
    font-size: 0.9375rem;
  }

  .head :global(.back) {
    display: none;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  h3 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgb(var(--ta-text-dim));
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .row {
    display: flex;
    gap: 0.25rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
  }

  .label {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.125rem 0 0.5rem;
    border-radius: 999px;
    background: rgb(var(--ta-info) / 0.12);
    color: rgb(var(--ta-info));
    font-size: 0.75rem;
  }

  .label button {
    width: 1.5rem;
    height: 1.5rem;
    border: 0;
    border-radius: 50%;
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .label button:focus-visible,
  .other:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
  }

  .add-label {
    flex: 1 1 7rem;
  }

  .add-label :global(.ta-input) {
    padding-block: 0.25rem;
    font-size: 0.8125rem;
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .consent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .consent-name {
    flex: 1;
    font-size: 0.8125rem;
  }

  .note {
    padding: 0.4rem 0.6rem;
    border-left: 3px solid rgb(var(--ta-warning) / 0.7);
    background: rgb(var(--ta-warning) / 0.06);
    border-radius: var(--ta-radius-sm);
  }

  .note-head {
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .note p {
    margin: 0.125rem 0 0;
    font-size: 0.8125rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .other {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .other:hover {
    background: rgb(var(--ta-elevated));
  }

  .other-top {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
  }

  .other-top .dim {
    margin-left: auto;
  }

  .other-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dim {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .pad {
    padding: 1rem;
  }

  @media (max-width: 1279px) {
    .head :global(.back) {
      display: inline-flex;
    }
  }
</style>
