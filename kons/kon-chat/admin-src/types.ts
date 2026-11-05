/** What the chat routes this panel calls answer, as far as the panel reads them. */

export interface Bot {
  id: string;
  name: string;
  slug: string;
  audience: "team" | "public";
  toolset?: string | null;
  dailyLimit: number;
  active: boolean;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  chunkCount: number;
  embedded: boolean;
}

export interface Conversation {
  id: string;
  lastAt: string;
  userId?: string | null;
  messageCount: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: string[] | null;
}

export interface Reply {
  conversationId: string;
  reply: string;
  sources?: (string | { title: string })[];
  toolCalls?: string[];
}
