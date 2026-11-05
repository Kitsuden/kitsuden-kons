/** What `GET /comments/moderation/queue` returns, as far as the view reads it. */

export type Status = "pending" | "published" | "hidden";

export interface QueueRow {
  id: string;
  subjectType: string;
  subjectId: string;
  authorName?: string | null;
  body: string;
  status: Status;
  createdAt?: string | null;
  /** The content it hangs from; null when it no longer exists. */
  subject: { title: string; slug: string } | null;
}

export interface QueueResponse {
  data?: QueueRow[];
  total?: number;
  counts?: Partial<Record<Status, number>>;
}

export interface BulkResponse {
  moderated: number;
  requested: number;
  status: Status;
}
