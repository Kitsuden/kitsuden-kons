/**
 * The board's words, in Spanish, English and Portuguese
 * ============================================================================
 *
 * The board ships inside the kon, so its texts do too: a site that mounts it should not have to
 * translate a card table. `boardTexts(lang)` picks by the language's first part (`pt-BR` → `pt`);
 * anything else gets English. A site can still override single strings through the board's
 * `texts` prop.
 */

export interface BoardTexts {
  // ── The deck, before playing ──
  yourDeck: string;
  yourDeckNote: string;
  modeRules: string;
  modeFree: string;
  modeRulesNote: string;
  modeFreeNote: string;
  startFromMeta: string;
  writeMine: string;
  metaNote: string;
  deckPlaceholder: string;
  noHeaderNote: (first: string, next: string) => string;
  shuffleAndStart: string;
  template: string;
  cardCount: (n: number) => string;
  pasteToStart: string;
  sectionSize: (size: string) => string;

  // ── Playing ──
  draw: string;
  shuffle: string;
  mulligan: string;
  nextPhase: string;
  endTurn: string;
  rollDie: string;
  undo: string;
  otherDeck: string;
  turnLine: (turn: number, phase: string) => string;
  freeTable: string;
  withRules: string;
  engineNote: string;
  empty: string;
  pileCount: (n: number) => string;
  log: string;
  nothingYet: string;
  hand: (n: number) => string;
  emptyHand: string;
  faceDown: string;
  close: string;
  tap: string;
  untap: string;
  flip: string;
  addCounter: string;
  counterName: string;
  moveTo: string;
  decrease: (what: string) => string;
  increase: (what: string) => string;

  // ── Images ──
  myImages: string;
  byodNotice: string;
  sources: string;
  noSources: string;
  addFolder: string;
  addZip: string;
  addTemplate: string;
  addCardUrls: string;
  addPack: string;
  label: string;
  link: string;
  templateHint: string;
  cardUrlsHint: string;
  packHint: string;
  add: string;
  cancel: string;
  remove: string;
  moveUp: string;
  moveDown: string;
  enabled: string;
  notOnThisDevice: string;
  reopen: string;
  synced: string;
  localOnly: string;
  cacheUsage: (count: number, size: string) => string;
  clearCache: string;
  clearCacheDone: string;
  keepStorage: string;
  storageKept: string;
  dropHint: string;
  dropped: string;
  forgetImage: string;
  useImageFile: string;
  imageRejected: string;
  linkRefused: (why: string) => string;
  /** `urlProblem`'s reasons (English, shared with the server) in this language. */
  linkReasons: Record<string, string>;
  saveFailed: string;
  zipFailed: string;
  origin: Record<
    "cache" | "folder" | "zip" | "dropped" | "template" | "cardUrls" | "pack" | "placeholder",
    string
  >;
}

const es: BoardTexts = {
  yourDeck: "Tu mazo",
  yourDeckNote:
    "Pega la lista —una carta por línea, con las copias delante— y se baraja aquí mismo. No se envía a ninguna parte y no hace falta cuenta.",
  modeRules: "Partida con reglas",
  modeFree: "Mesa libre",
  modeRulesNote: "Se comprueba el tamaño de cada sección y el tope de copias, como en una mesa de torneo.",
  modeFreeNote:
    "Se baraja lo que pegues, sin comprobar tamaños ni copias. Las zonas y el secreto siguen siendo los del juego.",
  startFromMeta: "Empezar por una del meta",
  writeMine: "Escribo la mía",
  metaNote:
    "Son las cartas más jugadas de cada arquetipo: sirven para ver cómo se mueve el mazo, pero no son listas completas ni legales. Por eso se abren en mesa libre.",
  deckPlaceholder: "3 Nombre de la carta\n2 Otra carta\n\n# Otra sección\n1 Una más",
  noHeaderNote: (first, next) => `Sin cabecera todo va a «${first}». Para las demás, una línea «# ${next}» por delante.`,
  shuffleAndStart: "Barajar y empezar",
  template: "Plantilla",
  cardCount: (n) => `${n} ${n === 1 ? "carta" : "cartas"}`,
  pasteToStart: "Pega una lista de cartas para empezar.",
  sectionSize: (size) => `${size} cartas`,

  draw: "Robar",
  shuffle: "Barajar",
  mulligan: "Mulligan",
  nextPhase: "Siguiente fase",
  endTurn: "Fin de turno",
  rollDie: "Tirar un dado",
  undo: "Deshacer",
  otherDeck: "Otro mazo",
  turnLine: (turn, phase) => `Turno ${turn} · ${phase}`,
  freeTable: "mesa libre",
  withRules: "partida con reglas",
  engineNote: "el motor vigila las zonas; los efectos de las cartas los ejecutas tú moviendo.",
  empty: "Vacía",
  pileCount: (n) => `${n} ${n === 1 ? "carta" : "cartas"}`,
  log: "Registro",
  nothingYet: "Todavía no has hecho nada.",
  hand: (n) => `Mano · ${n}`,
  emptyHand: "Sin cartas en la mano. Pulsa «Robar».",
  faceDown: "Carta boca abajo",
  close: "Cerrar",
  tap: "Girar",
  untap: "Enderezar",
  flip: "Voltear",
  addCounter: "+1 marca",
  counterName: "marca",
  moveTo: "Mover a",
  decrease: (what) => `Restar a ${what}`,
  increase: (what) => `Sumar a ${what}`,

  myImages: "Mis imágenes",
  byodNotice: "Las imágenes de las cartas las pones tú y no salen de tu navegador.",
  sources: "De dónde salen, en este orden",
  noSources: "Aún no hay fuentes.",
  addFolder: "Carpeta",
  addZip: "Archivo zip",
  addTemplate: "Plantilla de enlace",
  addCardUrls: "Enlaces por carta",
  addPack: "Paquete comunitario",
  label: "Nombre",
  link: "Enlace",
  templateHint: "Un enlace https con {id} o {name} donde va la carta (el id o el nombre).",
  cardUrlsHint: "Una carta por línea: id o nombre, una barra «|» y el enlace https.",
  packHint: "El enlace https a un paquete (.json) que hayas elegido tú.",
  add: "Añadir",
  cancel: "Cancelar",
  remove: "Quitar",
  moveUp: "Subir",
  moveDown: "Bajar",
  enabled: "Activa",
  notOnThisDevice: "No está en este dispositivo",
  reopen: "Volver a abrir",
  synced: "Guardado en tu cuenta",
  localOnly: "Guardado solo en este navegador",
  cacheUsage: (count, size) => `${count} ${count === 1 ? "imagen guardada" : "imágenes guardadas"} · ${size}`,
  clearCache: "Vaciar imágenes de este juego",
  clearCacheDone: "Imágenes borradas de este navegador.",
  keepStorage: "Pedir que no se borren",
  storageKept: "El navegador las conservará.",
  dropHint: "Suelta o pega una imagen sobre una carta para usarla.",
  dropped: "Soltadas a mano",
  forgetImage: "Olvidar esta imagen",
  useImageFile: "Elegir imagen",
  imageRejected: "Eso no es una imagen PNG, JPEG, WebP, GIF o AVIF de menos de 15 MB.",
  linkRefused: (why) => `Enlace no válido: ${why}.`,
  linkReasons: {
    empty: "está vacío",
    "longer than 600 characters": "tiene más de 600 caracteres",
    "not a URL": "no es un enlace",
    "only https: links": "solo valen enlaces https",
    "no user or password in the link": "no puede llevar usuario ni contraseña",
    "not a public host": "no apunta a un sitio público",
  },
  saveFailed: "No se pudo guardar.",
  zipFailed: "No se pudo leer el zip.",
  origin: {
    cache: "guardada",
    folder: "carpeta",
    zip: "zip",
    dropped: "a mano",
    template: "plantilla",
    cardUrls: "enlace",
    pack: "paquete",
    placeholder: "dibujada",
  },
};

const en: BoardTexts = {
  yourDeck: "Your deck",
  yourDeckNote:
    "Paste the list —one card per line, copies first— and it is shuffled right here. Nothing is sent anywhere and no account is needed.",
  modeRules: "Game with rules",
  modeFree: "Free table",
  modeRulesNote: "Each section's size and the copy limit are checked, as at a tournament table.",
  modeFreeNote:
    "Whatever you paste is shuffled, without checking sizes or copies. Zones and hidden information stay the game's.",
  startFromMeta: "Start from a meta list",
  writeMine: "I'll write mine",
  metaNote:
    "These are each archetype's most played cards: good for seeing how the deck moves, but not complete or legal lists. That is why they open on the free table.",
  deckPlaceholder: "3 Card name\n2 Another card\n\n# Another section\n1 One more",
  noHeaderNote: (first, next) => `Without a header everything goes to “${first}”. For the others, put a “# ${next}” line before.`,
  shuffleAndStart: "Shuffle and start",
  template: "Template",
  cardCount: (n) => `${n} ${n === 1 ? "card" : "cards"}`,
  pasteToStart: "Paste a card list to start.",
  sectionSize: (size) => `${size} cards`,

  draw: "Draw",
  shuffle: "Shuffle",
  mulligan: "Mulligan",
  nextPhase: "Next phase",
  endTurn: "End turn",
  rollDie: "Roll a die",
  undo: "Undo",
  otherDeck: "Another deck",
  turnLine: (turn, phase) => `Turn ${turn} · ${phase}`,
  freeTable: "free table",
  withRules: "game with rules",
  engineNote: "the engine keeps the zones; you carry out card effects by moving cards.",
  empty: "Empty",
  pileCount: (n) => `${n} ${n === 1 ? "card" : "cards"}`,
  log: "Log",
  nothingYet: "Nothing done yet.",
  hand: (n) => `Hand · ${n}`,
  emptyHand: "No cards in hand. Press “Draw”.",
  faceDown: "Face-down card",
  close: "Close",
  tap: "Tap",
  untap: "Untap",
  flip: "Flip",
  addCounter: "+1 counter",
  counterName: "counter",
  moveTo: "Move to",
  decrease: (what) => `Lower ${what}`,
  increase: (what) => `Raise ${what}`,

  myImages: "My images",
  byodNotice: "You bring the card images, and they never leave your browser.",
  sources: "Where they come from, in this order",
  noSources: "No sources yet.",
  addFolder: "Folder",
  addZip: "Zip file",
  addTemplate: "Link template",
  addCardUrls: "Per-card links",
  addPack: "Community pack",
  label: "Name",
  link: "Link",
  templateHint: "An https link with {id} or {name} where the card goes.",
  cardUrlsHint: "One card per line: id or name, a “|” and the https link.",
  packHint: "The https link to a pack (.json) you chose.",
  add: "Add",
  cancel: "Cancel",
  remove: "Remove",
  moveUp: "Move up",
  moveDown: "Move down",
  enabled: "On",
  notOnThisDevice: "Not on this device",
  reopen: "Open again",
  synced: "Saved to your account",
  localOnly: "Saved in this browser only",
  cacheUsage: (count, size) => `${count} ${count === 1 ? "image saved" : "images saved"} · ${size}`,
  clearCache: "Clear this game's images",
  clearCacheDone: "Images removed from this browser.",
  keepStorage: "Ask to keep them",
  storageKept: "The browser will keep them.",
  dropHint: "Drop or paste an image on a card to use it.",
  dropped: "Dropped by hand",
  forgetImage: "Forget this image",
  useImageFile: "Choose image",
  imageRejected: "That is not a PNG, JPEG, WebP, GIF or AVIF image under 15 MB.",
  linkRefused: (why) => `Invalid link: ${why}.`,
  linkReasons: {
    empty: "it is empty",
    "longer than 600 characters": "it is longer than 600 characters",
    "not a URL": "it is not a link",
    "only https: links": "only https links work",
    "no user or password in the link": "it cannot carry a user or password",
    "not a public host": "it does not point to a public site",
  },
  saveFailed: "Could not save.",
  zipFailed: "Could not read the zip.",
  origin: {
    cache: "saved",
    folder: "folder",
    zip: "zip",
    dropped: "by hand",
    template: "template",
    cardUrls: "link",
    pack: "pack",
    placeholder: "drawn",
  },
};

const pt: BoardTexts = {
  yourDeck: "Seu baralho",
  yourDeckNote:
    "Cole a lista —uma carta por linha, com as cópias na frente— e ela é embaralhada aqui mesmo. Nada é enviado e não precisa de conta.",
  modeRules: "Partida com regras",
  modeFree: "Mesa livre",
  modeRulesNote: "O tamanho de cada seção e o limite de cópias são conferidos, como numa mesa de torneio.",
  modeFreeNote:
    "Embaralha o que você colar, sem conferir tamanhos nem cópias. As zonas e o segredo continuam os do jogo.",
  startFromMeta: "Começar por uma do meta",
  writeMine: "Escrevo a minha",
  metaNote:
    "São as cartas mais jogadas de cada arquétipo: servem para ver como o baralho se move, mas não são listas completas nem legais. Por isso abrem na mesa livre.",
  deckPlaceholder: "3 Nome da carta\n2 Outra carta\n\n# Outra seção\n1 Mais uma",
  noHeaderNote: (first, next) => `Sem cabeçalho tudo vai para «${first}». Para as outras, uma linha «# ${next}» antes.`,
  shuffleAndStart: "Embaralhar e começar",
  template: "Modelo",
  cardCount: (n) => `${n} ${n === 1 ? "carta" : "cartas"}`,
  pasteToStart: "Cole uma lista de cartas para começar.",
  sectionSize: (size) => `${size} cartas`,

  draw: "Comprar",
  shuffle: "Embaralhar",
  mulligan: "Mulligan",
  nextPhase: "Próxima fase",
  endTurn: "Fim do turno",
  rollDie: "Rolar um dado",
  undo: "Desfazer",
  otherDeck: "Outro baralho",
  turnLine: (turn, phase) => `Turno ${turn} · ${phase}`,
  freeTable: "mesa livre",
  withRules: "partida com regras",
  engineNote: "o motor cuida das zonas; os efeitos das cartas você executa movendo.",
  empty: "Vazia",
  pileCount: (n) => `${n} ${n === 1 ? "carta" : "cartas"}`,
  log: "Registro",
  nothingYet: "Você ainda não fez nada.",
  hand: (n) => `Mão · ${n}`,
  emptyHand: "Sem cartas na mão. Toque em «Comprar».",
  faceDown: "Carta virada para baixo",
  close: "Fechar",
  tap: "Virar",
  untap: "Desvirar",
  flip: "Inverter",
  addCounter: "+1 marcador",
  counterName: "marcador",
  moveTo: "Mover para",
  decrease: (what) => `Diminuir ${what}`,
  increase: (what) => `Aumentar ${what}`,

  myImages: "Minhas imagens",
  byodNotice: "As imagens das cartas são suas e não saem do seu navegador.",
  sources: "De onde vêm, nesta ordem",
  noSources: "Ainda não há fontes.",
  addFolder: "Pasta",
  addZip: "Arquivo zip",
  addTemplate: "Modelo de link",
  addCardUrls: "Links por carta",
  addPack: "Pacote da comunidade",
  label: "Nome",
  link: "Link",
  templateHint: "Um link https com {id} ou {name} onde vai a carta.",
  cardUrlsHint: "Uma carta por linha: id ou nome, uma barra «|» e o link https.",
  packHint: "O link https de um pacote (.json) que você escolheu.",
  add: "Adicionar",
  cancel: "Cancelar",
  remove: "Remover",
  moveUp: "Subir",
  moveDown: "Descer",
  enabled: "Ativa",
  notOnThisDevice: "Não está neste dispositivo",
  reopen: "Abrir de novo",
  synced: "Salvo na sua conta",
  localOnly: "Salvo só neste navegador",
  cacheUsage: (count, size) => `${count} ${count === 1 ? "imagem salva" : "imagens salvas"} · ${size}`,
  clearCache: "Apagar as imagens deste jogo",
  clearCacheDone: "Imagens apagadas deste navegador.",
  keepStorage: "Pedir para não apagar",
  storageKept: "O navegador vai mantê-las.",
  dropHint: "Solte ou cole uma imagem sobre uma carta para usá-la.",
  dropped: "Soltas à mão",
  forgetImage: "Esquecer esta imagem",
  useImageFile: "Escolher imagem",
  imageRejected: "Isso não é uma imagem PNG, JPEG, WebP, GIF ou AVIF de menos de 15 MB.",
  linkRefused: (why) => `Link inválido: ${why}.`,
  linkReasons: {
    empty: "está vazio",
    "longer than 600 characters": "tem mais de 600 caracteres",
    "not a URL": "não é um link",
    "only https: links": "só valem links https",
    "no user or password in the link": "não pode ter usuário nem senha",
    "not a public host": "não aponta para um site público",
  },
  saveFailed: "Não foi possível salvar.",
  zipFailed: "Não foi possível ler o zip.",
  origin: {
    cache: "salva",
    folder: "pasta",
    zip: "zip",
    dropped: "à mão",
    template: "modelo",
    cardUrls: "link",
    pack: "pacote",
    placeholder: "desenhada",
  },
};

export const BOARD_TEXTS = { es, en, pt } as const;
export type BoardLanguage = keyof typeof BOARD_TEXTS;

/** The texts for a language tag (`es`, `pt-BR`, `en-US`…); English for anything else. */
export function boardTexts(lang?: string | null, overrides: Partial<BoardTexts> = {}): BoardTexts {
  const base = (lang ?? "").toLowerCase().split(/[-_]/)[0] as BoardLanguage;
  return { ...(BOARD_TEXTS[base] ?? en), ...overrides };
}

/** "1.2 MB", in the board's language. */
export function formatBytes(bytes: number, lang?: string | null): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const n = new Intl.NumberFormat(lang ?? undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${n} ${units[unit]}`;
}
