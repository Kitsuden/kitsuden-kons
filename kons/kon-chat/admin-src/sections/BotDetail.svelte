<!-- One bot: how to embed it, what it knows, a try, and the conversations people had with it. -->
<script lang="ts">
  import {
    Badge,
    Button,
    ChatMessage,
    ConfirmDialog,
    DataTable,
    DescriptionList,
    EmptyState,
    Field,
    Icon,
    Input,
    PromptInput,
    Sheet,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Bot, Conversation, KnowledgeDoc, Message, Reply } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad, type Load } from "../ui/load.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  const {
    api,
    bot,
    apiBase,
    visitorId,
    onBack,
  }: { api: Api; bot: Bot; apiBase: string; visitorId: string; onBack: () => void } = $props();

  let docs = $state<KnowledgeDoc[]>([]);
  let doc = $state({ title: "", content: "" });
  let teaching = $state(false);
  let forgetting = $state<KnowledgeDoc | null>(null);
  let confirmForget = $state(false);

  let question = $state("");
  let asked = $state<string | null>(null);
  let answer = $state<Reply | null>(null);
  let waiting = $state(false);
  let conversationId: string | null = null;
  /** Bumped by every try and by "New conversation": an answer that arrives late is dropped. */
  let attempt = 0;

  let conversations = $state<Conversation[]>([]);
  let reading = $state<Conversation | null>(null);
  let readingOpen = $state(false);
  let transcript = $state<Message[]>([]);
  /** The load of the conversation being read: a new one per conversation, so each starts at its skeleton. */
  let transcriptLoad = $state<Load | null>(null);

  const who = (c: Conversation) => (c.userId ? "Team member" : "Visitor");
  const at = (c: Conversation) => String(c.lastAt).replace("T", " ").slice(0, 16);

  const about = $derived.by(() => {
    const base = `${location.origin}${apiBase}/chat`;
    return [
      { label: "Slug", value: bot.slug, mono: true },
      { label: "Audience", value: bot.audience === "public" ? "Public" : "Team" },
      { label: "Tools", value: bot.toolset || "None" },
      { label: "Messages per day", value: bot.dailyLimit },
      bot.audience === "public"
        ? {
            label: "On a website",
            value: `<script src="${base}/public/widget.js" data-bot="${bot.slug}" defer><\/script>`,
            copy: true,
          }
        : { label: "For the team", value: `POST ${base}/bots/${bot.slug}/chat`, copy: true },
    ];
  });

  const docColumns: DataColumn<KnowledgeDoc>[] = [
    { key: "title", header: "Document", sortable: true, hideable: false },
    { key: "chunkCount", header: "Chunks", sortable: true, align: "right" },
    { key: "embedded", header: "Search", sortable: true, value: (d) => (d.embedded ? "By meaning" : "By words") },
  ];

  const conversationColumns: DataColumn<Conversation>[] = [
    { key: "lastAt", header: "Last message", sortable: true, hideable: false },
    { key: "who", header: "Who", sortable: true, value: who },
    { key: "messageCount", header: "Messages", sortable: true, align: "right" },
  ];

  const sources = (r: Reply) => (r.sources ?? []).map((s) => (typeof s === "string" ? s : s.title));

  const knowledge = createLoad(async () => {
    docs = (await api.get<{ data: KnowledgeDoc[] }>(`bots/${seg(bot.id)}/knowledge`)).data;
  });

  const history = createLoad(async () => {
    conversations = (await api.get<{ data: Conversation[] }>(`bots/${seg(bot.id)}/conversations`)).data;
  });

  $effect(() => {
    untrack(() => Promise.all([knowledge.load(), history.load()]));
  });

  async function teach() {
    const title = doc.title.trim();
    if (!title || !doc.content.trim()) return toast.error("A document needs a title and text");
    teaching = true;
    try {
      const { data } = await api.post<{ data: KnowledgeDoc }>(`bots/${seg(bot.id)}/knowledge`, {
        title,
        content: doc.content,
      });
      toast.success(`Learned "${title}" in ${data.chunkCount} chunks`, {
        description: data.embedded ? "Searched by meaning." : "Searched by words: the core has no embeddings provider.",
      });
      doc = { title: "", content: "" };
      await knowledge.load();
    } catch (e) {
      failed("Could not teach the document", e);
    } finally {
      teaching = false;
    }
  }

  async function forget() {
    const d = forgetting!;
    try {
      await api.del(`knowledge/${seg(d.id)}`);
    } catch (e) {
      failed("Could not forget the document", e);
      throw e;
    }
    toast.success(`Forgot "${d.title}"`);
    await knowledge.load();
  }

  async function send(message: string) {
    const mine = ++attempt;
    asked = message;
    answer = null;
    waiting = true;
    try {
      const route =
        bot.audience === "public" ? `public/bots/${seg(bot.slug)}/chat` : `bots/${seg(bot.slug)}/chat`;
      const body: Record<string, unknown> = { message, ...(conversationId ? { conversationId } : {}) };
      if (bot.audience === "public") body.visitorId = visitorId;
      const { data } = await api.post<{ data: Reply }>(route, body);
      if (mine !== attempt) return;
      conversationId = data.conversationId;
      answer = data;
      void history.load();
    } catch (e) {
      if (mine === attempt) failed(`${bot.name} did not answer`, e);
    } finally {
      if (mine === attempt) waiting = false;
    }
  }

  function newConversation() {
    attempt++;
    waiting = false;
    conversationId = null;
    asked = null;
    answer = null;
  }

  function read(c: Conversation) {
    reading = c;
    transcript = [];
    const load = createLoad(async () => {
      const { messages } = (await api.get<{ data: { messages: Message[] } }>(`conversations/${seg(c.id)}`)).data;
      if (reading === c) transcript = messages;
    });
    transcriptLoad = load;
    readingOpen = true;
    void load.load();
  }
</script>

<div>
  <Button size="sm" variant="ghost" onclick={onBack}><Icon name="arrow-left" /> Back to bots</Button>
</div>

<Panel title={bot.name}>
  {#snippet status()}
    <Badge variant={bot.active ? "success" : "default"} dot>{bot.active ? "On" : "Off"}</Badge>
  {/snippet}
  <DescriptionList ariaLabel={`About ${bot.name}`} items={about} copyLabel="Copy" copiedLabel="Copied" />
</Panel>

<Panel title="What it knows" description="Whoever may talk to this bot may read what it is taught.">
  {#snippet status()}
    {#if knowledge.ready}<Badge>{docs.length} {docs.length === 1 ? "document" : "documents"}</Badge>{/if}
  {/snippet}
  <DataTable
    caption={`What ${bot.name} knows`}
    rows={docs}
    columns={docColumns}
    rowKey="id"
    rowLabel={(d) => d.title}
    loading={knowledge.loading}
    error={knowledge.error}
    onRetry={knowledge.load}
  >
    {#snippet rowActions(d)}
      <Button
        size="sm"
        variant="danger-ghost"
        ariaLabel={`Forget ${d.title}`}
        onclick={() => {
          forgetting = d;
          confirmForget = true;
        }}>Forget</Button
      >
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="It knows nothing yet"
        description="Teach it a document with the form below: it answers from what it is taught."
      />
    {/snippet}
  </DataTable>

  <h3 class="sub">Teach it a document</h3>
  <FormGrid label="Teach it a document" onsubmit={teach}>
    <Field label="Title" required class="wide">
      <Input bind:value={doc.title} />
    </Field>
    <Field label="Text or Markdown" required class="wide">
      <Textarea bind:value={doc.content} rows={8} />
    </Field>
    {#snippet actions()}
      <Button type="submit" loading={teaching}>Teach it</Button>
    {/snippet}
  </FormGrid>
</Panel>

<Panel title="Try it">
  {#snippet actions()}
    <Button size="sm" variant="outline" onclick={newConversation}>New conversation</Button>
  {/snippet}
  {#if asked}
    <div class="thread">
      <ChatMessage role="user" content={asked} />
      {#if waiting}
        <ChatMessage role="assistant" author={bot.name} pending />
      {:else if answer && (sources(answer).length || answer.toolCalls?.length)}
        {@const used = sources(answer)}
        {@const tools = answer.toolCalls ?? []}
        <ChatMessage role="assistant" author={bot.name} content={answer.reply}>
          {#snippet footer()}
            {#if used.length}<div>Sources: {used.join(", ")}</div>{/if}
            {#if tools.length}<div>Tools: {tools.join(", ")}</div>{/if}
          {/snippet}
        </ChatMessage>
      {:else if answer}
        <ChatMessage role="assistant" author={bot.name} content={answer.reply} />
      {/if}
    </div>
  {/if}
  <PromptInput
    bind:value={question}
    placeholder="Ask something"
    ariaLabel="Question to try"
    sendLabel="Send"
    loading={waiting}
    onSend={send}
  />
</Panel>

<Panel title="Conversations">
  {#snippet status()}
    {#if history.ready}<Badge>{conversations.length}</Badge>{/if}
  {/snippet}
  <DataTable
    caption={`Conversations with ${bot.name}`}
    rows={conversations}
    columns={conversationColumns}
    rowKey="id"
    rowLabel={(c) => `${who(c)}, ${at(c)}`}
    pageSize={20}
    loading={history.loading}
    error={history.error}
    onRetry={history.load}
  >
    {#snippet cell(c, col)}
      {#if col.key === "lastAt"}
        <time datetime={c.lastAt}>{at(c)}</time>
      {:else if col.key === "messageCount"}
        {c.messageCount}
      {:else}
        {col.value?.(c)}
      {/if}
    {/snippet}
    {#snippet rowActions(c)}
      <Button size="sm" variant="ghost" ariaLabel={`Read the conversation of ${at(c)}`} onclick={() => read(c)}>Read</Button>
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No conversations yet"
        description="They are listed here once someone talks to the bot. Try it above."
      />
    {/snippet}
  </DataTable>
</Panel>

<Sheet
  bind:open={readingOpen}
  title={reading ? `${who(reading)}, ${at(reading)}` : "Conversation"}
  description={reading ? `${reading.messageCount} messages` : undefined}
  closeLabel={CLOSE}
>
  {#if reading && transcriptLoad}
    <Loadable
      load={transcriptLoad}
      empty={transcript.length === 0}
      emptyTitle="No messages"
      emptyDescription="This conversation has nothing in it."
      errorTitle="The conversation did not load"
    >
      <div class="thread">
        {#each transcript as m, i (i)}
          {@const role = m.role === "user" ? "user" : "assistant"}
          {@const author = m.role === "user" ? who(reading) : bot.name}
          {#if m.toolCalls?.length}
            {@const tools = m.toolCalls}
            <ChatMessage {role} {author} content={m.content}>
              {#snippet footer()}Tools: {tools.join(", ")}{/snippet}
            </ChatMessage>
          {:else}
            <ChatMessage {role} {author} content={m.content} />
          {/if}
        {/each}
      </div>
    </Loadable>
  {/if}
</Sheet>

<ConfirmDialog
  bind:open={confirmForget}
  title={`Forget "${forgetting?.title ?? ""}"?`}
  description="The document is deleted: the bot stops answering from it."
  confirmLabel="Forget"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={forget}
/>

<style>
  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .thread {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>
