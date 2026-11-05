/**
 * The kon SDK operations of a source file, sliced up: each slice goes from its `method:` to the next
 * one's, so it holds its `access`, its `permission` and the handler body. For tests that read a kon's code.
 */
export interface SourceOperation {
  method: string;
  route: string;
  body: string;
}

export function sourceOperations(source: string): SourceOperation[] {
  const re = /method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*route:\s*"([^"]*)"/g;
  const marks = [...source.matchAll(re)].map((m) => ({ method: m[1]!, route: m[2]!, index: m.index! }));
  return marks.map((m, i) => ({
    method: m.method,
    route: m.route,
    body: source.slice(m.index, marks[i + 1]?.index ?? source.length),
  }));
}
