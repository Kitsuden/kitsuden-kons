/**
 * kon-chat: lists that grow with use take a page size
 * ============================================================================
 *
 * A bot's conversations and rated answers page with `limit` (default and cap 200, what they always returned)
 * and `offset`; its knowledge takes an optional `limit` (without it every document, as before). Each answers
 * `hasMore`. The kon on PGlite as a non-superuser with row security.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonChat } from "../../kons/kon-chat";
import { registerChatPolicy } from "../../kons/kon-chat/chat.policy";

import { APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let botId: string;
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

/** Rows written as the superuser that migrated, past row security (the kon writes these as the system). */
async function asOwner(text: string, params: unknown[] = []) {
  await client.exec("RESET ROLE");
  try {
    await client.query(text, params);
  } finally {
    await client.exec(`SET ROLE ${APP_ROLE}`);
  }
}

beforeAll(async () => {
  const migrations = readdirSync(resolve(__dirname, "../../kons/kon-chat/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  client = await migratedBase("kon-chat", migrations);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  request = requestAs(host.mount(createKonChat(ctx)));
  registerChatPolicy();

  const bot = await request("admin", "POST", "/bots", { slug: "pages", name: "Pages", agentId: "agent-pages", audience: "team" });
  expect(bot.status, await bot.clone().text()).toBe(201);
  botId = (await json(bot)).data.id;
  for (const title of ["First", "Second"]) expect((await request("admin", "POST", `/bots/${botId}/knowledge`, { title, content: `${title} document.` })).status).toBe(201);
  for (const n of [1, 2]) {
    await asOwner("INSERT INTO chat_conversations (id, bot_id, user_id, message_count, last_at) VALUES ($1, $2, 'u', 2, now() - $3::interval)", [`conv-${n}`, botId, `${n} minutes`]);
    await asOwner("INSERT INTO chat_messages (id, conversation_id, bot_id, role, content, created_at) VALUES ($1, $2, $3, 'user', 'Question?', now() - interval '1 hour')", [`q-${n}`, `conv-${n}`, botId]);
    await asOwner("INSERT INTO chat_messages (id, conversation_id, bot_id, role, content, feedback, feedback_at) VALUES ($1, $2, $3, 'assistant', 'Answer.', -1, now() - $4::interval)", [`a-${n}`, `conv-${n}`, botId, `${n} minutes`]);
  }
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerChatPolicy();
});

describe("kon-chat list pagination", () => {
  const idOf = (row: { id?: string; messageId?: string }) => row.id ?? row.messageId;

  for (const list of ["knowledge", "conversations", "feedback"]) {
    it(`${list}: limit=1 answers one row and hasMore; without limit every row`, async () => {
      const page = await json(request("admin", "GET", `/bots/${botId}/${list}?limit=1`));
      expect(page.data).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const next = await json(request("admin", "GET", `/bots/${botId}/${list}?limit=1&offset=1`));
      expect(next.data).toHaveLength(1);
      expect(idOf(next.data[0])).not.toBe(idOf(page.data[0]));
      expect(next.hasMore).toBe(false);

      const all = await json(request("admin", "GET", `/bots/${botId}/${list}`));
      expect(all.data).toHaveLength(2);
      expect(all.hasMore).toBe(false);
    });
  }

  it("rated answers still carry the question before them, and a filter still applies", async () => {
    const down = await json(request("admin", "GET", `/bots/${botId}/feedback?rating=down&limit=1`));
    expect(down.data[0]).toMatchObject({ question: "Question?", answer: "Answer.", rating: -1 });
    expect((await json(request("admin", "GET", `/bots/${botId}/feedback?rating=up`))).data).toEqual([]);
  });

  it("a page size beyond the cap is refused", async () => {
    expect((await request("admin", "GET", `/bots/${botId}/conversations?limit=201`)).status).toBe(422);
    expect((await request("admin", "GET", `/bots/${botId}/knowledge?limit=0`)).status).toBe(422);
  });
});
