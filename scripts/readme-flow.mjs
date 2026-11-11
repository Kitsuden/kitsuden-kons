#!/usr/bin/env node
/**
 * Writes assets/readme/kon-add.svg: the animated picture at the top of the README
 * (one command installs a kon; what the backend has afterwards). The numbers come
 * from kons/kon-blog/kon.json, so the picture cannot disagree with the kon.
 *
 * It is an SVG with CSS keyframes and no script, because that is what GitHub renders
 * inside a README. Readers who ask for reduced motion get the last frame, still.
 *
 *   node scripts/readme-flow.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "assets", "readme", "kon-add.svg");
const blog = JSON.parse(readFileSync(join(root, "kons", "kon-blog", "kon.json"), "utf8"));
const tables = blog.tables.length;
const views = (blog.admin?.views ?? []).length;

const C = {
  ink: "#0f1520",
  panel: "#161e2c",
  line: "#2a3446",
  text: "#f1f5f9",
  dim: "#a8b3c4",
  agent: "#7ab4ff",
  ok: "#34d399",
};
const LOOP = 14; // seconds
const END = 96; // % of the loop where everything fades for the restart

const frames = [];
let n = 0;
/** An element visible from `from`% to `to`% of the loop. `still` is what reduced motion shows. */
function show(from, to = END, still = to >= END) {
  const name = `k${n++}`;
  frames.push(
    `@keyframes ${name}{0%,${Math.max(from - 0.01, 0)}%{opacity:0}${from}%,${to}%{opacity:1}${Math.min(to + 1.5, 100)}%,100%{opacity:0}}`
  );
  return `style="opacity:${still ? 1 : 0};animation:${name} ${LOOP}s linear infinite"`;
}
const sans = `class="s"`;
const mono = `class="m"`;

const done = (y, text, at) =>
  `<g ${show(at)}><rect x="56" y="${y - 17}" width="3" height="24" fill="${C.ok}"/>` +
  `<text ${mono} x="72" y="${y}" font-size="16" fill="${C.text}">${text}</text></g>`;
const got = (y, label, text, at) =>
  `<rect x="640" y="${y}" width="504" height="44" rx="9" fill="none" stroke="${C.line}" stroke-width="2"/>` +
  `<text ${sans} x="660" y="${y + 28}" font-size="15" font-weight="600" fill="${C.dim}">${label}</text>` +
  `<g ${show(at)}><rect x="640" y="${y}" width="504" height="44" rx="9" fill="${C.panel}" stroke="${C.ok}" stroke-width="2"/>` +
  `<text ${sans} x="660" y="${y + 28}" font-size="15" font-weight="600" fill="${C.text}">${label}</text>` +
  `<text ${mono} x="776" y="${y + 28}" font-size="14" fill="${C.text}">${text}</text></g>`;

const body = [
  `<rect x="1" y="1" width="1198" height="418" rx="28" fill="${C.ink}" stroke="${C.line}" stroke-width="2"/>`,
  `<line x1="612" y1="34" x2="612" y2="348" stroke="${C.line}" stroke-width="2"/>`,
  `<line x1="56" y1="364" x2="1144" y2="364" stroke="${C.line}" stroke-width="2"/>`,
  `<text ${sans} x="56" y="66" font-size="18" font-weight="700" fill="${C.text}">In your Kitsuden folder</text>`,
  `<text ${sans} x="640" y="66" font-size="18" font-weight="700" fill="${C.text}">What your backend has now</text>`,

  `<g ${show(3)}><text ${mono} x="56" y="112" font-size="15" fill="${C.agent}">$ pnpm kitsuden kon add blog --from ../kitsuden-kons</text></g>`,
  done(152, "copied to packages/kons/kon-blog", 14),
  done(190, "dependencies installed", 22),
  done(228, "migrations applied", 30),
  `<g ${show(40)}><text ${mono} x="56" y="270" font-size="16" fill="${C.dim}">restart the API</text></g>`,

  got(92, "Tables", `${tables} tables, with row security`, 31),
  got(144, "REST API", `${blog.mount.path}/…  in OpenAPI`, 45),
  got(196, "MCP tools", "its operations, at /api/mcp", 53),
  got(248, "Permissions", "its own scopes per agent key", 61),
  got(300, "Panel", `${views} views for setup and oversight`, 69),

  `<g ${show(1, 38, false)}><text ${sans} x="56" y="398" font-size="19" fill="${C.text}">One command copies the kon, installs it and runs its migrations.</text></g>`,
  `<g ${show(40)}><text ${sans} x="56" y="398" font-size="19" fill="${C.text}">After a restart your backend has a blog: API, MCP tools, permissions and panel views.</text></g>`,
];

const desc =
  `Animation. In a Kitsuden folder, the command pnpm kitsuden kon add blog --from ../kitsuden-kons copies the kon to ` +
  `packages/kons/kon-blog, installs its dependencies and applies its migrations. After restarting the API the backend has ` +
  `${tables} new tables with row security, a REST API under ${blog.mount.path} documented in OpenAPI, the kon's operations as ` +
  `MCP tools at /api/mcp, its own scopes for each agent key, and ${views} admin panel views for setup and oversight.`;

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="1200" height="420" role="img" aria-labelledby="t d">\n` +
  `<title id="t">What installing a kon adds to a Kitsuden backend</title>\n` +
  `<desc id="d">${desc}</desc>\n` +
  `<style>.s{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif}` +
  `.m{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}` +
  `${frames.join("")}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>\n` +
  `${body.join("\n")}\n</svg>\n`;

writeFileSync(out, svg);
console.log(`${out}: ${svg.length} bytes, ${n} animated parts, ${LOOP}s loop`);
