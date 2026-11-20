/**
 * kon-agile — events for automation rules, and ready-made rules (1.4)
 * ============================================================================
 *
 * Notifications used to stay inside the kon: the host never gives a kon an account's email. The core
 * can send them out, though, through automation rules a person writes (docs/automation.md): WHEN an
 * agile event arrives, IF its payload matches, THEN `core:send-mail` or `core:webhook`. A kon may not
 * write those rules itself (a kon's own rules use only its own steps), so this file:
 *
 *   · declares the events (`AGILE_EVENTS`, read by `defineKonSdk({ events })`), which puts them in
 *     the catalog the panel and agents read (`GET /api/automation/catalog`);
 *   · registers one mail template, `agile.issue-event`, for `core:send-mail`;
 *   · serves rule bodies ready to post to `POST /api/actions` (`GET /api/agile/rule-templates`), with
 *     the address or URL left for the person to fill in.
 *
 * The events are emitted after commit and at most once (docs/kons/events.md): a rule may miss one if
 * the process stops at that moment. The kon's own history and notifications are written in the
 * request's transaction and stay the record.
 */

import { heading, layout, mail, paragraph, type Mailable, type AnyOperation } from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";

import { declareOp, registry } from "./operations";

const ISSUE_PAYLOAD = {
  projectId: "uuid of the project",
  issueId: "uuid of the issue",
  key: "issue key, e.g. PLAT-12",
  name: "title of the issue",
  type: "issue | feature | bug | improvement | epic | sub_issue | spike",
  priority: "urgent | high | medium | low",
  stateId: "uuid of its state",
  stateGroup: "backlog | unstarted | started | completed | cancelled",
  assigneeId: "member (person or agent) id, or null",
  actorId: "who made the change (a person, an agent, or `system`)",
} as const;

/** Everything the kon emits, with its payload (documentation, not validation). */
export const AGILE_EVENTS = {
  emits: {
    "agile:issue.created": {
      description: "An issue was created (on the board, from an approved intake, or by an agent).",
      payload: ISSUE_PAYLOAD,
    },
    "agile:issue.updated": {
      description: "Fields of an issue changed. `changed` lists which ones.",
      payload: { ...ISSUE_PAYLOAD, changed: "list of the changed field names" },
    },
    "agile:issue.state_changed": {
      description: "An issue moved to another state. `stateGroup: completed` means it was finished.",
      payload: { ...ISSUE_PAYLOAD, previousStateId: "uuid of the state it left" },
    },
    "agile:issue.assigned": {
      description: "An issue got a new assignee (assignment or hand-off).",
      payload: { ...ISSUE_PAYLOAD, previousAssigneeId: "member id, or null", handoff: "true for a hand-off" },
    },
    "agile:issue.commented": {
      description: "Someone commented on an issue.",
      payload: {
        ...ISSUE_PAYLOAD,
        commentId: "uuid of the comment",
        excerpt: "first 280 characters of the comment",
        mentions: "list of mentioned member ids",
      },
    },
    "agile:pull_request.linked": {
      description: "A GitHub pull request mentioned an issue, or its state changed (open, closed, merged).",
      payload: {
        projectId: "uuid of the project",
        issueId: "uuid of the issue",
        key: "issue key",
        repo: "owner/name",
        number: "pull request number",
        url: "pull request URL",
        state: "open | closed | merged",
      },
    },
    "agile:agent_work": {
      description: "A piece of work was queued for an agent member (assignment, mention, hand-off, schedule).",
      payload: {
        workId: "uuid of the work row",
        projectId: "uuid of the project",
        issueId: "uuid of the issue, or null",
        agentId: "the agent's id",
        trigger: "assigned | mention | handoff | schedule | manual",
      },
    },
  },
  listens: [],
};

export type AgileEventName = keyof typeof AGILE_EVENTS.emits;

// ── The mail template ───────────────────────────────────────────────────────

export interface IssueMailData {
  to: string;
  /** `agile:issue.created`, … (the rule passes `{{eventName}}`). */
  event?: string;
  key?: string;
  name?: string;
  stateGroup?: string;
  excerpt?: string;
  /** Free line the rule adds, e.g. "Urgent bug in production". */
  note?: string;
}

const WHAT: Record<string, string> = {
  "agile:issue.created": "New issue",
  "agile:issue.updated": "Issue updated",
  "agile:issue.state_changed": "Issue moved",
  "agile:issue.assigned": "Issue assigned",
  "agile:issue.commented": "New comment",
  "agile:pull_request.linked": "Pull request",
};

/**
 * One template for every agile event: what happened, the issue's key and name, and the rule's note.
 * The template helpers escape every value, so a title with `<script>` arrives as text.
 */
export const issueEventMail: Mailable<IssueMailData> = {
  name: "agile.issue-event",
  envelope: (data) => ({
    to: data.to,
    subject: `[${data.key ?? "agile"}] ${WHAT[data.event ?? ""] ?? "Agile"}: ${data.name ?? ""}`.trim(),
    tag: "agile-issue-event",
  }),
  content: (data) => ({
    html: layout({
      preheader: `${data.key ?? ""} ${data.name ?? ""}`.trim(),
      body:
        heading(`${WHAT[data.event ?? ""] ?? "Agile"}: ${data.key ?? ""}`) +
        paragraph(data.name ?? "") +
        (data.stateGroup ? paragraph(`State: ${data.stateGroup}`) : "") +
        (data.excerpt ? paragraph(data.excerpt) : "") +
        (data.note ? paragraph(data.note) : ""),
    }),
  }),
};

/** Registers the template once per process (the mailer is shared by every kon). */
export function registerAgileMails(): void {
  try {
    if (!mail.has(issueEventMail.name)) mail.register(issueEventMail);
  } catch {
    // A host without the engine's mailer: rules that send mail will say so in their dry run.
  }
}

// ── Ready-made rules ────────────────────────────────────────────────────────

export interface RuleTemplate {
  id: string;
  title: string;
  description: string;
  /** What the person must replace before posting it. */
  fill: string[];
  /** The body for `POST /api/actions`. */
  rule: Record<string, unknown>;
}

const issueMailData = (note?: string) => ({
  to: "team@example.com",
  event: "{{eventName}}",
  key: "{{event.key}}",
  name: "{{event.name}}",
  stateGroup: "{{event.stateGroup}}",
  ...(note ? { note } : {}),
});

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "mail-urgent-issue",
    title: "Email the team about urgent issues",
    description: "When an issue is created with priority urgent, email a team address.",
    fill: ["projectId", "config.steps[0].config.data.to"],
    rule: {
      name: "Agile: urgent issue",
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: "agile:issue.created",
        conditions: [
          { field: "projectId", op: "eq", value: "<project id>" },
          { field: "priority", op: "eq", value: "urgent" },
        ],
      },
      config: {
        steps: [{ handler: "core:send-mail", config: { mailable: "agile.issue-event", data: issueMailData("Priority: urgent") } }],
      },
    },
  },
  {
    id: "mail-issue-done",
    title: "Email when an issue is finished",
    description: "When an issue enters a completed state, email an address (the requester, a client's list).",
    fill: ["projectId", "config.steps[0].config.data.to"],
    rule: {
      name: "Agile: issue done",
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: "agile:issue.state_changed",
        conditions: [
          { field: "projectId", op: "eq", value: "<project id>" },
          { field: "stateGroup", op: "eq", value: "completed" },
        ],
      },
      config: {
        steps: [{ handler: "core:send-mail", config: { mailable: "agile.issue-event", data: issueMailData() } }],
      },
    },
  },
  {
    id: "mail-new-comment",
    title: "Email every new comment",
    description: "Forward each comment of a project to a mailbox (a shared inbox, a client's contact).",
    fill: ["projectId", "config.steps[0].config.data.to"],
    rule: {
      name: "Agile: new comment",
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: "agile:issue.commented",
        conditions: [{ field: "projectId", op: "eq", value: "<project id>" }],
      },
      config: {
        steps: [
          {
            handler: "core:send-mail",
            config: { mailable: "agile.issue-event", data: { ...issueMailData(), excerpt: "{{event.excerpt}}" } },
          },
        ],
      },
    },
  },
  {
    id: "webhook-issue-changes",
    title: "Send every issue change to a webhook",
    description:
      "Created, updated, moved and assigned issues as signed POSTs (Slack, Discord, Teams through their incoming webhooks, or your own service). One rule per event; this one is for state changes.",
    fill: ["projectId", "config.steps[0].config.url", "config.steps[0].config.secret"],
    rule: {
      name: "Agile: issue moved → webhook",
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: "agile:issue.state_changed",
        conditions: [{ field: "projectId", op: "eq", value: "<project id>" }],
      },
      config: {
        steps: [
          {
            handler: "core:webhook",
            config: { url: "https://hooks.example.com/agile", secret: "<a secret the receiver checks>" },
          },
        ],
      },
    },
  },
  {
    id: "webhook-merged-pull-request",
    title: "Announce merged pull requests",
    description: "When a linked pull request is merged, POST it to a webhook (a release channel).",
    fill: ["projectId", "config.steps[0].config.url"],
    rule: {
      name: "Agile: pull request merged → webhook",
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: "agile:pull_request.linked",
        conditions: [
          { field: "projectId", op: "eq", value: "<project id>" },
          { field: "state", op: "eq", value: "merged" },
        ],
      },
      config: { steps: [{ handler: "core:webhook", config: { url: "https://hooks.example.com/releases" } }] },
    },
  },
];

const Template = z
  .object({ id: z.string(), title: z.string(), description: z.string(), fill: z.array(z.string()), rule: z.object({}).passthrough() })
  .passthrough();

/** `GET /rule-templates`: the events and the ready-made rules. */
export function eventOperations(): AnyOperation[] {
  const routes = registry();
  routes.get(
    "/rule-templates",
    {
      ...declareOp(
        "list-rule-templates",
        "Ready-made automation rules for agile events",
        "The events the tracker emits (with their payload) and automation rules ready to post to `POST /api/actions`: email the team about urgent issues, email when an issue is finished, forward comments, send changes to a webhook, announce merged pull requests. Replace what `fill` lists (the project id, the address or URL) first. Writing a rule needs the core's rule permission (an administrator). Any signed-in account.",
        {},
        {
          schema: z
            .object({ events: z.record(z.string(), z.unknown()), templates: z.array(Template) })
            .passthrough(),
        },
        []
      ),
      unpaginated: "A fixed catalogue written in the kon's code: the agile events and a handful of ready-made rules.",
    },
    async (c) => c.json({ events: AGILE_EVENTS.emits, templates: RULE_TEMPLATES })
  );
  return routes.ops;
}
