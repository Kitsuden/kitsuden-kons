/**
 * The blueprint editor's model: an outline of a definition (what the TreeView shows), reading and
 * writing one part of it by its path, the starting shape of each new part, and which parts the
 * server's problems point at. The definition stays plain JSON: the server's schema is the judge.
 */
import type { TreeNode } from "$lib/components";

export type Definition = Record<string, unknown> & {
  commands?: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
  modals?: Array<Record<string, unknown>>;
  panels?: Array<Record<string, unknown>>;
};

export type Kind = "section" | "command" | "subcommand" | "trigger" | "modal" | "panel" | "row" | "component";

export const SECTIONS = ["commands", "panels", "modals", "triggers"] as const;
export type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<Section, string> = {
  commands: "Commands",
  panels: "Panels",
  modals: "Modals",
  triggers: "Triggers",
};

/** A path is the JSON path of a part, joined with dots: `commands.0.subcommands.2`. */
export function kindOf(path: string): Kind {
  const parts = path.split(".");
  if (parts.length === 1) return "section";
  if (parts[0] === "commands") return parts.length >= 4 ? "subcommand" : "command";
  if (parts[0] === "panels") return parts.length === 2 ? "panel" : parts.length === 4 ? "row" : "component";
  if (parts[0] === "modals") return "modal";
  return "trigger";
}

export function getAt(def: Definition, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), def);
}

/** A copy of the definition with `value` at `path` (undefined removes it from its list). */
export function setAt(def: Definition, path: string, value: unknown): Definition {
  // JSON in, JSON out: a definition is plain data (and a reactive proxy cannot be structured-cloned).
  const copy = JSON.parse(JSON.stringify(def)) as Definition;
  const parts = path.split(".");
  let o = copy as Record<string, unknown>;
  for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  const last = parts.at(-1)!;
  if (value === undefined && Array.isArray(o)) (o as unknown[]).splice(Number(last), 1);
  else if (value === undefined) delete o[last];
  else o[last] = value;
  return copy;
}

/** Appends to a list and gives the new item's path. */
export function append(def: Definition, listPath: string, item: unknown): { def: Definition; path: string } {
  const list = (getAt(def, listPath) as unknown[] | undefined) ?? [];
  const copy = setAt(def, listPath, [...list, item]);
  return { def: copy, path: `${listPath}.${list.length}` };
}

/** What a new part starts as: valid on its own, so the check stays green while you edit. */
export function starter(section: Section, def: Definition): unknown {
  const n = ((def[section] as unknown[] | undefined)?.length ?? 0) + 1;
  switch (section) {
    case "commands":
      return { name: `command-${n}`, description: "What it does", steps: [{ do: "reply", content: "Hello, {{user.mention}}!", ephemeral: true }] };
    case "panels":
      return {
        id: `panel-${n}`,
        content: "Live panel",
        components: [[{ type: "button", id: `panel-${n}-ok`, label: "OK", style: "primary", steps: [{ do: "reply", content: "Pressed.", ephemeral: true }] }]],
      };
    case "modals":
      return { id: `form-${n}`, title: "Form", inputs: [{ id: "text", label: "Text", style: "paragraph", required: true }], steps: [{ do: "reply", content: "{{input.text}}", ephemeral: true }] };
    case "triggers":
      return { on: "member_join", steps: [{ do: "kv_increment", key: "joins", by: 1 }] };
  }
}

/** "1 step", "3 steps". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stepsOf = (v: unknown) => count((v as unknown[] | undefined)?.length ?? 0, "step", "steps");

const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

/** The outline: sections, their parts, a command's subcommands, a panel's rows and components. */
export function outline(def: Definition, problems: Array<{ path: string }> = []): TreeNode[] {
  const bad = (path: string) => problems.some((p) => p.path === path || p.path.startsWith(`${path}.`));
  const mark = (node: TreeNode): TreeNode => (bad(node.id) ? { ...node, badge: "!", badgeTone: "error" } : node);

  return SECTIONS.map((section) => {
    const list = (def[section] as Array<Record<string, unknown>> | undefined) ?? [];
    const children = list.map((item, i): TreeNode => {
      const path = `${section}.${i}`;
      switch (section) {
        case "commands": {
          const subs = (item.subcommands as Array<Record<string, unknown>> | undefined) ?? [];
          return mark({
            id: path,
            label: `/${str(item.name, "?")}`,
            description: subs.length ? count(subs.length, "subcommand", "subcommands") : stepsOf(item.steps),
            children: subs.length
              ? subs.map((s, j) => mark({ id: `${path}.subcommands.${j}`, label: str(s.name, "?"), description: stepsOf(s.steps) }))
              : undefined,
          });
        }
        case "panels": {
          const rows = (item.components as unknown[][] | undefined) ?? [];
          return mark({
            id: path,
            label: str(item.id, "panel"),
            description: (item.refreshOn as string[] | undefined)?.length ? "live" : undefined,
            children: rows.length
              ? rows.map((row, r) =>
                  mark({
                    id: `${path}.components.${r}`,
                    label: `Row ${r + 1}`,
                    children: row.map((c, k) => {
                      const comp = c as Record<string, unknown>;
                      return mark({ id: `${path}.components.${r}.${k}`, label: str(comp.label ?? comp.placeholder ?? comp.id, "component"), description: str(comp.type, "") });
                    }),
                  })
                )
              : undefined,
          });
        }
        case "modals":
          return mark({ id: path, label: str(item.id, "modal"), description: count((item.inputs as unknown[] | undefined)?.length ?? 0, "field", "fields") });
        default:
          return mark({ id: path, label: item.on === "kon_event" ? str(item.event, "kon_event") : str(item.on, "trigger"), description: stepsOf(item.steps) });
      }
    });
    return mark({ id: section, label: SECTION_LABEL[section], badge: String(list.length), children: children.length ? children : undefined });
  });
}

/** The problems that point at a part or inside it, with the path shown from that part. */
export function problemsAt(problems: Array<{ path: string; message: string }>, path: string) {
  return problems
    .filter((p) => p.path === path || p.path.startsWith(`${path}.`) || (path === "" && p.path === "(definition)"))
    .map((p) => ({ ...p, path: p.path.slice(path.length + 1) || "(here)" }));
}

/** The path of the part a list belongs to: `panels.0.components.1.2` → `panels.0`. */
export function parentPath(path: string): string | null {
  const parts = path.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : null;
}

/** A component's buttons as a preview reads them: label, style, or a select's options. */
export interface PreviewComponent {
  type: string;
  label: string;
  style?: string;
  options?: string[];
}

export function previewOf(message: Record<string, unknown> | undefined) {
  if (!message) return null;
  const rows = ((message.components as unknown[][] | undefined) ?? []).map((row) =>
    row.map((c): PreviewComponent => {
      const comp = c as Record<string, unknown>;
      const t = str(comp.type, "button");
      const fromKon = comp.optionsFrom as { path?: string; scope?: string } | undefined;
      return {
        type: t,
        label: str(comp.label ?? comp.placeholder, t === "select" ? "Pick one" : t.replace("_", " ")),
        style: str(comp.style, t === "link" ? "link" : "secondary"),
        options: (comp.options as Array<{ label: string }> | undefined)?.map((o) => o.label) ?? (fromKon ? [`from ${fromKon.path ?? fromKon.scope}`] : undefined),
      };
    })
  );
  return {
    content: typeof message.content === "string" ? message.content : null,
    embeds: ((message.embeds as Array<Record<string, unknown>> | undefined) ?? []).map((e) => ({
      title: typeof e.title === "string" ? e.title : null,
      description: typeof e.description === "string" ? e.description : null,
      color: typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : null,
      fields: ((e.fields as Array<{ name: string; value: string; inline?: boolean }> | undefined) ?? []).slice(0, 25),
      footer: typeof e.footer === "string" ? e.footer : null,
    })),
    rows,
  };
}
