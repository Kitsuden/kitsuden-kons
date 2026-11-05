/**
 * Answers as they are written, in the AI SDK's UI message stream protocol
 * ============================================================================
 *
 * Server-sent events, one JSON part per `data:` line, ending in `data: [DONE]`, with the header
 * `x-vercel-ai-ui-message-stream: v1`: what `useChat` from the AI SDK reads with no adapter, in React, Svelte or
 * Vue. Text arrives as `text-delta`s while the model writes (when the core's provider streams; in one piece when
 * it does not), each tool call as `tool-input-available` and its result as `tool-output-available`, a tool held
 * for a person as `tool-approval-request` with the proposal id, the documents used as `source-document`, and the
 * conversation's ids in a `data-chat` part, so the next question continues it.
 *
 * The run keeps going after the response has started, outside the request's transaction: it writes as the
 * system, in a scope of its own (`ctx.db.background`).
 */

import { asSystem } from "@kitsuden/engine";
import type { KonAgentEvent, KonContext } from "@kitsuden/shared";
import { createId } from "@paralleldrive/cuid2";

import type { TurnResult } from "./chat.service";

type Part = Record<string, unknown> & { type: string };

export const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Runs `turn` and streams it. `turn` gets the message id announced up front and a listener for the run's events;
 * `publicView` leaves out what a visitor should not see (internal document ids, cost).
 */
export function streamTurn(
  ctx: KonContext,
  turn: (messageId: string, onEvent: (event: KonAgentEvent) => void) => Promise<TurnResult>,
  publicView: boolean
): Response {
  const encoder = new TextEncoder();
  const messageId = createId();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (part: Part | "[DONE]") => controller.enqueue(encoder.encode(`data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`));
      let textId: string | null = null;
      const closeText = () => {
        if (textId) send({ type: "text-end", id: textId });
        textId = null;
      };
      const onEvent = (event: KonAgentEvent) => {
        switch (event.type) {
          case "step-start":
            send({ type: "start-step" });
            break;
          case "text-delta":
            if (!textId) {
              textId = createId();
              send({ type: "text-start", id: textId });
            }
            send({ type: "text-delta", id: textId, delta: event.delta });
            break;
          case "tool-call":
            closeText();
            send({ type: "tool-input-available", toolCallId: event.id, toolName: event.name, input: event.input });
            break;
          case "tool-result":
            if (event.pendingApproval) {
              send({ type: "tool-approval-request", toolCallId: event.id, approvalId: event.pendingApproval.proposalId });
            } else send({ type: "tool-output-available", toolCallId: event.id, output: parse(event.output) });
            break;
          case "step-finish":
            closeText();
            send({ type: "finish-step" });
            break;
        }
      };
      const run = async () => {
        send({ type: "start", messageId });
        try {
          const result = await asSystem(() => turn(messageId, onEvent));
          closeText();
          for (const source of result.sources) {
            send({ type: "source-document", sourceId: publicView ? source.title : source.documentId, mediaType: "text/plain", title: source.title });
          }
          send({
            type: "data-chat",
            data: {
              conversationId: result.conversationId,
              messageId: result.messageId,
              pendingApprovals: result.pendingApprovals.map((a) => a.proposalId),
              ...(publicView ? {} : { costUsd: result.costUsd }),
            },
          });
          send({ type: "finish" });
        } catch (err) {
          closeText();
          const status = (err as { status?: number }).status;
          // What the person may read: our own messages (limits, not found), never an internal error's text.
          send({ type: "error", errorText: status && status < 500 ? (err as Error).message : "The assistant could not answer." });
        }
        send("[DONE]");
        controller.close();
      };
      const background = ctx.db.background?.bind(ctx.db) ?? (<T>(fn: () => T) => fn());
      void background(run);
    },
  });
  return new Response(body, { status: 200, headers: STREAM_HEADERS });
}
