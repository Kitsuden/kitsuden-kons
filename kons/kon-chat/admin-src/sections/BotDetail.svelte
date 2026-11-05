<!-- One bot: how to embed it, what it knows, a try, and the conversations people had with it. -->
<script lang="ts">
  import {
    Alert,
    Button,
    ChatMessage,
    Input,
    PromptInput,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, ok, seg, type Api, type Note } from "../api";
  import type { Bot, Conversation, KnowledgeDoc, Message, Reply } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";
  import Row from "../ui/Row.svelte";

  const {
    api,
    bot,
    apiBase,
    visitorId,
  }: { api: Api; bot: Bot; apiBase: string; visitorId: string } = $props();

  let docs = $state<KnowledgeDoc[]>([]);
  let docNote = $state<Note | null>(null);
  let doc = $state({ title: "", content: "" });
  let teaching = $state(false);

  let question = $state("");
  let asked = $state<string | null>(null);
  let answer = $state<Reply | null>(null);
  let tryError = $state<string | null>(null);
  let waiting = $state(false);
  let conversationId: string | null = null;
  /** Bumped by every try and by "New conversation": an answer that arrives late is dropped. */
  let attempt = 0;

  let conversations = $state<Conversation[]>([]);
  let reading = $state<Conversation | null>(null);
  let transcript = $state<Message[]>([]);
  let readError = $state<string | null>(null);

  const embed = $derived.by(() => {
    const base = `${location.origin}${apiBase}/chat`;
    return bot.audience === "public"
      ? `On a website: <script src="${base}/public/widget.js" data-bot="${bot.slug}" defer><\/script>`
      : `For the team: POST ${base}/bots/${bot.slug}/chat`;
  });

  const sources = (r: Reply) => (r.sources ?? []).map((s) => (typeof s === "string" ? s : s.title));

  async function loadDocs() {
    try {
      docs = (await api.get<{ data: KnowledgeDoc[] }>(`bots/${seg(bot.id)}/knowledge`)).data;
    } catch (e) {
      docNote = fail(e);
    }
  }

  async function loadConversations() {
    try {
      conversations = (await api.get<{ data: Conversation[] }>(`bots/${seg(bot.id)}/conversations`)).data;
    } catch {
      // The list is oversight; trying the bot still works without it.
    }
  }

  $effect(() => {
    untrack(() => Promise.all([loadDocs(), loadConversations()]));
  });

  async function teach() {
    const title = doc.title.trim();
    if (!title || !doc.content.trim()) return (docNote = { ok: false, lines: ["A document needs a title and text."] });
    teaching = true;
    try {
      const { data } = await api.post<{ data: KnowledgeDoc }>(`bots/${seg(bot.id)}/knowledge`, {
        title,
        content: doc.content,
      });
      docNote = ok(
        `Learned in ${data.chunkCount} chunks, searched ${data.embedded ? "by meaning" : "by words (no embeddings provider in the core)"}.`
      );
      doc = { title: "", content: "" };
      await loadDocs();
    } catch (e) {
      docNote = fail(e);
    } finally {
      teaching = false;
    }
  }

  async function forget(d: KnowledgeDoc) {
    try {
      await api.del(`knowledge/${seg(d.id)}`);
      await loadDocs();
    } catch (e) {
      docNote = fail(e);
    }
  }

  async function send(message: string) {
    const mine = ++attempt;
    asked = message;
    answer = null;
    tryError = null;
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
      void loadConversations();
    } catch (e) {
      if (mine === attempt) tryError = e instanceof Error ? e.message : String(e);
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
    tryError = null;
  }

  async function read(c: Conversation) {
    reading = c;
    readError = null;
    try {
      transcript = (await api.get<{ data: { messages: Message[] } }>(`conversations/${seg(c.id)}`)).data.messages;
    } catch (e) {
      transcript = [];
      readError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<Panel title={bot.name}>
  <p class="embed">{embed}</p>
</Panel>

<Panel title="What it knows">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Document</TableHead>
        <TableHead>Chunks</TableHead>
        <TableHead>Search</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each docs as d (d.id)}
        <TableRow>
          <TableCell>{d.title}</TableCell>
          <TableCell>{d.chunkCount}</TableCell>
          <TableCell>{d.embedded ? "By meaning" : "By words"}</TableCell>
          <TableCell><Button size="sm" variant="ghost" onclick={() => forget(d)}>Forget</Button></TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No documents" />
      {/each}
    </TableBody>
  </Table>
  <div class="teach">
    <Input bind:value={doc.title} placeholder="Title" aria-label="Document title" />
    <Textarea
      bind:value={doc.content}
      rows={8}
      placeholder="Text or Markdown. Whoever may talk to this bot may read it."
      aria-label="Document text"
    />
  </div>
  <Row>
    <Button size="sm" loading={teaching} onclick={teach}>Teach it</Button>
  </Row>
  <Result note={docNote} />
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
  {#if tryError}<Alert variant="error">{tryError}</Alert>{/if}
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
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Last message</TableHead>
        <TableHead>Who</TableHead>
        <TableHead>Messages</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each conversations as c (c.id)}
        <TableRow>
          <TableCell>{String(c.lastAt).replace("T", " ").slice(0, 16)}</TableCell>
          <TableCell>{c.userId ? "Team member" : "Visitor"}</TableCell>
          <TableCell>{c.messageCount}</TableCell>
          <TableCell><Button size="sm" variant="ghost" onclick={() => read(c)}>Read</Button></TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No conversations" />
      {/each}
    </TableBody>
  </Table>
  {#if readError}<Alert variant="error">{readError}</Alert>{/if}
  {#if reading && transcript.length}
    <div class="thread">
      {#each transcript as m, i (i)}
        {@const role = m.role === "user" ? "user" : "assistant"}
        {@const author = m.role === "user" ? (reading.userId ? "Team member" : "Visitor") : bot.name}
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
  {/if}
</Panel>

<style>
  .embed {
    margin: 0;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    overflow-wrap: anywhere;
  }

  .teach {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .thread {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
</style>
