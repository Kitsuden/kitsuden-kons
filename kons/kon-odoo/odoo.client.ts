/**
 * Odoo — client for the JSON-2 API (Odoo 19 and later)
 * ============================================================================
 *
 *   POST <base>/json/2/<model>/<method>
 *   Authorization: bearer <api key>
 *   X-Odoo-Database: <db>            (only when the server hosts several databases)
 *   { "ids": [...], "context": {...}, <named arguments> }
 *
 * The answer is the method's return value as JSON. An error is a 4xx or 5xx with
 * `{ name, message, arguments, context, debug }`.
 *
 * Three facts of that API shape this file:
 *   · arguments go by NAME, never by position;
 *   · every call is its own transaction: two calls cannot be made atomic from here, so anything
 *     that must happen together is one method of the bridge module in Odoo;
 *   · the key acts as its user: access rights, record rules and field access all apply.
 *
 * No dependency and no global: the caller passes the function that makes the request, so the
 * host decides which hosts may be reached and tests answer without a network.
 */

export type OdooDomain = Array<string | [string, string, unknown]>;

/** What makes the HTTP request. `fetch` has this shape; the host's pinned fetch does too. */
export type OdooTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface OdooClientOptions {
  /** `https://erp.example.com`, with no path */
  baseUrl: string;
  /**
   * The key, or how to get the current one. Left out when the transport adds the credential
   * itself, which is how the host's connections work: the key never reaches this code.
   */
  apiKey?: string | (() => string | Promise<string>);
  /** Database name, for a server with more than one */
  database?: string;
  transport?: OdooTransport;
  /** Milliseconds before a call is abandoned. Default 15000 */
  timeoutMs?: number;
  /** Sent on every call. `lang` selects the translation of translatable fields */
  context?: Record<string, unknown>;
  userAgent?: string;
}

export interface OdooCallOptions {
  /** Records the method runs on. Left out for model-level methods */
  ids?: number[];
  context?: Record<string, unknown>;
  timeoutMs?: number;
}

export type OdooErrorKind =
  | "auth" // the key is wrong, expired or revoked
  | "access" // the key's user may not do this
  | "missing" // a record that is not there (deleted, or never existed)
  | "validation" // Odoo refused the values
  | "not-found" // the model or the method does not exist on this instance
  | "unavailable" // no answer, a timeout, or a 5xx that is not an Odoo exception
  | "server"; // an exception inside Odoo

/** A failed call. `kind` is what the caller branches on; the rest is for the log. */
export class OdooError extends Error {
  readonly kind: OdooErrorKind;
  readonly status: number;
  /** Fully qualified Python exception, e.g. `odoo.exceptions.AccessError` */
  readonly odooName: string | null;
  readonly model: string;
  readonly method: string;

  constructor(input: {
    kind: OdooErrorKind;
    status: number;
    message: string;
    odooName?: string | null;
    model: string;
    method: string;
  }) {
    super(input.message);
    this.name = "OdooError";
    this.kind = input.kind;
    this.status = input.status;
    this.odooName = input.odooName ?? null;
    this.model = input.model;
    this.method = input.method;
  }

  /** Worth another attempt later: the instance did not answer, as opposed to answering "no". */
  get retryable(): boolean {
    return this.kind === "unavailable";
  }
}

function kindOf(status: number, odooName: string | null): OdooErrorKind {
  const name = odooName ?? "";
  if (status === 401 || name.endsWith("AccessDenied") || name.endsWith("Unauthorized")) return "auth";
  if (name.endsWith("AccessError") || status === 403) return "access";
  if (name.endsWith("MissingError")) return "missing";
  if (name.endsWith("ValidationError") || name.endsWith("UserError") || status === 422) {
    return "validation";
  }
  if (status === 404) return "not-found";
  if (status >= 500 && !odooName) return "unavailable";
  return "server";
}

/** Only letters, digits, dots and underscores: the model and the method go into the URL. */
const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const METHOD = /^[a-z][a-z0-9_]*$/;

export interface OdooClient {
  call<T = unknown>(
    model: string,
    method: string,
    args?: Record<string, unknown>,
    options?: OdooCallOptions
  ): Promise<T>;
  searchRead<T = Record<string, unknown>>(
    model: string,
    query: {
      domain?: OdooDomain;
      fields: string[];
      limit?: number;
      offset?: number;
      order?: string;
      context?: Record<string, unknown>;
    }
  ): Promise<T[]>;
  searchCount(model: string, domain?: OdooDomain): Promise<number>;
  read<T = Record<string, unknown>>(model: string, ids: number[], fields: string[]): Promise<T[]>;
  /** Field name to its definition. Fields the key's user may not see are simply absent. */
  fieldsGet(model: string, attributes?: string[]): Promise<Record<string, { type: string }>>;
  create(model: string, values: Record<string, unknown>): Promise<number>;
  write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean>;
}

export function createOdooClient(options: OdooClientOptions): OdooClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const transport: OdooTransport = options.transport ?? ((url, init) => fetch(url, init));
  const defaultTimeout = options.timeoutMs ?? 15_000;

  async function call<T>(
    model: string,
    method: string,
    args: Record<string, unknown> = {},
    callOptions: OdooCallOptions = {}
  ): Promise<T> {
    if (!NAME.test(model)) throw new TypeError(`Not a model name: ${JSON.stringify(model)}`);
    // A leading underscore is a private method: Odoo refuses it, and so does this client, before
    // a request is made.
    if (!METHOD.test(method)) throw new TypeError(`Not a public method: ${JSON.stringify(method)}`);

    const key = typeof options.apiKey === "function" ? await options.apiKey() : options.apiKey;
    const context = { ...options.context, ...callOptions.context };
    const body: Record<string, unknown> = { ...args };
    if (callOptions.ids) body.ids = callOptions.ids;
    if (Object.keys(context).length > 0) body.context = context;

    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
      "user-agent": options.userAgent ?? "kitsuden-kon-odoo",
    };
    if (key) headers.authorization = `bearer ${key}`;
    if (options.database) headers["x-odoo-database"] = options.database;

    const fail = (kind: OdooErrorKind, status: number, message: string, odooName?: string | null) =>
      new OdooError({ kind, status, message, odooName, model, method });

    let response: Response;
    try {
      response = await transport(`${base}/json/2/${model}/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(callOptions.timeoutMs ?? defaultTimeout),
        // A redirect would carry the key to wherever it points.
        redirect: "error",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw fail("unavailable", 0, `Odoo did not answer ${model}.${method}: ${reason}`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const detail = (parsed && typeof parsed === "object" ? parsed : {}) as {
        name?: unknown;
        message?: unknown;
      };
      const odooName = typeof detail.name === "string" ? detail.name : null;
      const message =
        typeof detail.message === "string" && detail.message
          ? detail.message
          : `Odoo answered ${response.status} to ${model}.${method}`;
      throw fail(kindOf(response.status, odooName), response.status, message, odooName);
    }

    if (parsed === undefined) {
      // A 200 that is not JSON is a proxy or a login page, not Odoo's API.
      throw fail("unavailable", response.status, `Odoo's answer to ${model}.${method} is not JSON`);
    }
    return parsed as T;
  }

  return {
    call,
    searchRead: (model, query) =>
      call(
        model,
        "search_read",
        {
          domain: query.domain ?? [],
          fields: query.fields,
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.order ? { order: query.order } : {}),
        },
        { context: query.context }
      ),
    searchCount: (model, domain = []) => call<number>(model, "search_count", { domain }),
    read: (model, ids, fields) => call(model, "read", { fields }, { ids }),
    fieldsGet: (model, attributes = ["type"]) => call(model, "fields_get", { attributes }),
    async create(model, values) {
      // `create` takes a list and answers a list of ids, one per record.
      const ids = await call<number[] | number>(model, "create", { vals_list: [values] });
      const id = Array.isArray(ids) ? ids[0] : ids;
      if (typeof id !== "number") {
        throw new OdooError({
          kind: "server",
          status: 200,
          message: `Odoo's create on ${model} answered no id`,
          model,
          method: "create",
        });
      }
      return id;
    },
    write: (model, ids, values) => call<boolean>(model, "write", { vals: values }, { ids }),
  };
}

/**
 * Every record matching a domain, in pages, ordered by id so that a record written while the
 * walk runs is neither skipped nor read twice.
 */
export async function* searchReadAll<T extends { id: number }>(
  client: OdooClient,
  model: string,
  query: { domain?: OdooDomain; fields: string[]; pageSize?: number; context?: Record<string, unknown> }
): AsyncGenerator<T[], void, void> {
  const pageSize = query.pageSize ?? 200;
  let after = 0;
  for (;;) {
    const page = await client.searchRead<T>(model, {
      domain: [...(query.domain ?? []), ["id", ">", after]],
      fields: query.fields.includes("id") ? query.fields : ["id", ...query.fields],
      limit: pageSize,
      order: "id",
      context: query.context,
    });
    if (page.length === 0) return;
    yield page;
    after = page[page.length - 1].id;
    if (page.length < pageSize) return;
  }
}
