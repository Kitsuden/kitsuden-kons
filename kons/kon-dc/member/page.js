// kon-dc member page: rankings, the store and the member's own stats. No framework, no inline code
// (the page's CSP allows only this file). Every text from the server goes through textContent.
(() => {
  const guildId = (location.pathname.match(/\/member\/page\/(\d{15,20})/) || [])[1];
  const lang = (navigator.language || "en").slice(0, 2);
  const T = {
    en: { rankings: "Rankings", store: "Store", me: "Me", login: "Log in with Discord", logout: "Log out", coins: "Coins", levels: "Levels", week: "Most active this week", nobody: "Nobody yet.", nothing: "Nothing for sale yet.", buy: "Buy", soldOut: "Sold out", left: "left", loginToBuy: "Log in to buy", level: "Level", rank: "rank", credits: "Credits", rep: "Reputation", messages: "Messages this week", voice: "Minutes in voice this week", items: "Your items", noItems: "No items yet.", loginToSee: "Log in with Discord to see your stats.", error: "Something went wrong. Try again.", members: "members' page" },
    es: { rankings: "Rankings", store: "Tienda", me: "Yo", login: "Entrar con Discord", logout: "Salir", coins: "Monedas", levels: "Niveles", week: "Los más activos de la semana", nobody: "Nadie todavía.", nothing: "Todavía no hay nada a la venta.", buy: "Comprar", soldOut: "Agotado", left: "quedan", loginToBuy: "Entra para comprar", level: "Nivel", rank: "puesto", credits: "Créditos", rep: "Reputación", messages: "Mensajes esta semana", voice: "Minutos en voz esta semana", items: "Tus artículos", noItems: "Todavía no tienes artículos.", loginToSee: "Entra con Discord para ver tus estadísticas.", error: "Algo salió mal. Inténtalo otra vez.", members: "página de miembros", rarity: { common: "común", uncommon: "poco común", rare: "raro", epic: "épico", legendary: "legendario" } },
    pt: { rankings: "Rankings", store: "Loja", me: "Eu", login: "Entrar com Discord", logout: "Sair", coins: "Moedas", levels: "Níveis", week: "Os mais ativos da semana", nobody: "Ninguém ainda.", nothing: "Ainda não há nada à venda.", buy: "Comprar", soldOut: "Esgotado", left: "restam", loginToBuy: "Entre para comprar", level: "Nível", rank: "posição", credits: "Créditos", rep: "Reputação", messages: "Mensagens esta semana", voice: "Minutos em voz esta semana", items: "Seus itens", noItems: "Ainda sem itens.", loginToSee: "Entre com o Discord para ver suas estatísticas.", error: "Algo deu errado. Tente de novo.", members: "página de membros", rarity: { common: "comum", uncommon: "incomum", rare: "raro", epic: "épico", legendary: "lendário" } },
  }[lang] || null;
  const t = T || {
    rankings: "Rankings", store: "Store", me: "Me", login: "Log in with Discord", logout: "Log out", coins: "Coins", levels: "Levels", week: "Most active this week", nobody: "Nobody yet.", nothing: "Nothing for sale yet.", buy: "Buy", soldOut: "Sold out", left: "left", loginToBuy: "Log in to buy", level: "Level", rank: "rank", credits: "Credits", rep: "Reputation", messages: "Messages this week", voice: "Minutes in voice this week", items: "Your items", noItems: "No items yet.", loginToSee: "Log in with Discord to see your stats.", error: "Something went wrong. Try again.", members: "members' page",
  };
  document.documentElement.lang = T ? lang : "en";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c) n.append(c);
    return n;
  };
  const fmt = (n) => new Intl.NumberFormat(navigator.language || "en").format(n);
  const avatar = (u) =>
    u.avatar && /^(a_)?[0-9a-f]{32}$/.test(u.avatar)
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(u.id) >> 22n) % 6}.png`;
  const toast = (msg) => {
    const box = $("#toast");
    box.textContent = msg.replace(/\*\*/g, "");
    box.classList.add("on");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => box.classList.remove("on"), 3500);
  };

  let data = null;
  let tab = "rankings";

  function ranking(title, rows, value) {
    return el(
      "section",
      { class: "card" },
      el("h2", { text: title }),
      rows && rows.length
        ? el(
            "ol",
            { class: "rank" },
            rows.map((r) =>
              el(
                "li",
                {},
                el("span", { class: `pos${r.rank === 1 ? " p1" : ""}`, text: String(r.rank) }),
                el("img", { class: "av", src: avatar(r), alt: "", loading: "lazy" }),
                el("span", { class: "who", text: r.name }),
                el("span", { class: "val" }, value(r))
              )
            )
          )
        : el("p", { class: "empty", text: t.nobody })
    );
  }

  function rankings() {
    const lb = data.leaderboards;
    const cards = [];
    if (lb.coins) cards.push(ranking(t.coins, lb.coins, (r) => document.createTextNode(fmt(r.value))));
    if (lb.levels) cards.push(ranking(t.levels, lb.levels, (r) => el("span", {}, `${t.level} ${r.level} `, el("small", { text: `${fmt(r.value)} XP` }))));
    if (lb.week) cards.push(ranking(t.week, lb.week, (r) => document.createTextNode(fmt(r.value))));
    return el("div", { class: "grid" }, cards);
  }

  async function buy(item, button) {
    button.disabled = true;
    try {
      const res = await fetch(`/api/dc/member/guilds/${guildId}/buy`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item }),
      });
      const body = await res.json().catch(() => ({}));
      toast(body.message || body.error || t.error);
      if (res.ok) await load();
    } catch {
      toast(t.error);
    } finally {
      button.disabled = false;
    }
  }

  function store() {
    if (!data.store.length) return el("p", { class: "empty", text: t.nothing });
    return el(
      "div",
      { class: "grid" },
      data.store.map((i) => {
        const soldOut = i.left !== null && i.left <= 0;
        const button = el("button", { class: "btn primary", type: "button", disabled: soldOut || !data.me || !data.page.canBuy }, soldOut ? t.soldOut : data.me ? t.buy : t.loginToBuy);
        button.addEventListener("click", () => buy(i.item, button));
        return el(
          "article",
          { class: "card item" },
          el(
            "div",
            { class: "head" },
            i.imageUrl ? el("img", { src: i.imageUrl, alt: "", loading: "lazy" }) : el("span", { class: "emoji", "aria-hidden": "true", text: i.emoji || "🎁" }),
            el("div", {}, el("strong", { text: i.name }), el("div", {}, el("span", { class: `badge r-${i.rarity}`, text: (t.rarity && t.rarity[i.rarity]) || i.rarity })))
          ),
          i.description ? el("p", { class: "desc", text: i.description }) : null,
          el("div", { class: "row" }, el("span", { class: "val", text: `${fmt(i.price)} ${i.currency}` }), i.left !== null && !soldOut ? el("small", { class: "desc", text: `${fmt(i.left)} ${t.left}` }) : null),
          data.page.canBuy ? button : null
        );
      })
    );
  }

  function me() {
    const m = data.me;
    if (!m) return el("p", { class: "empty", text: t.loginToSee });
    const stat = (label, value) => el("div", { class: "stat" }, el("b", { text: value }), el("span", { text: label }));
    return el(
      "div",
      { class: "grid" },
      el(
        "section",
        { class: "card" },
        el("h2", { text: m.name }),
        m.bio ? el("p", { class: "desc", text: m.bio }) : null,
        el(
          "div",
          { class: "stats" },
          stat(t.coins, `${fmt(m.coins)} · #${m.coinsRank}`),
          stat(t.level, `${m.level} · #${m.levelRank}`),
          stat(t.credits, fmt(m.credits)),
          stat(t.rep, `+${fmt(m.rep)}`),
          stat(t.messages, fmt(m.weekMessages)),
          stat(t.voice, fmt(m.weekVoiceMinutes))
        )
      ),
      el(
        "section",
        { class: "card" },
        el("h2", { text: t.items }),
        m.items.length
          ? el("ol", { class: "rank" }, m.items.map((i) => el("li", {}, el("span", { class: "pos", "aria-hidden": "true", text: i.emoji || "•" }), el("span", { class: "who", text: i.name }), el("span", { class: "val", text: `× ${fmt(i.quantity)}` }))))
          : el("p", { class: "empty", text: t.noItems })
      )
    );
  }

  function render() {
    document.documentElement.style.setProperty("--accent", data.page.accent);
    document.title = data.page.title;
    $("#title").textContent = data.page.title;
    $("#subtitle").textContent = t.members;

    const account = $("#account");
    account.replaceChildren();
    if (data.me) {
      const out = el("button", { class: "btn", type: "button", text: t.logout });
      out.addEventListener("click", async () => {
        await fetch("/api/dc/member/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
        await load();
      });
      account.append(el("div", { class: "me-chip" }, el("img", { src: avatar(data.me), alt: "" }), el("strong", { text: data.me.name }), out));
    } else if (data.login) {
      account.append(el("a", { class: "btn", href: `/api/dc/member/login?guildId=${guildId}`, text: t.login }));
    }

    const tabs = [["rankings", t.rankings], ...(data.store.length || data.page.canBuy ? [["store", t.store]] : []), ["me", t.me]];
    const nav = $("#tabs");
    nav.replaceChildren(
      ...tabs.map(([id, label]) => {
        const b = el("button", { class: "tab", role: "tab", "aria-selected": String(tab === id), type: "button", text: label });
        b.addEventListener("click", () => {
          tab = id;
          render();
        });
        return b;
      })
    );
    $("#main").replaceChildren(tab === "store" ? store() : tab === "me" ? me() : rankings());
  }

  async function load() {
    try {
      const res = await fetch(`/api/dc/member/guilds/${guildId}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
      render();
    } catch {
      $("#main").replaceChildren(el("p", { class: "empty", text: t.error }));
    }
  }

  if (guildId) load();
})();
