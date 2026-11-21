/**
 * The two-player table's words, in Spanish, English and Portuguese
 * ============================================================================
 *
 * The board's texts (`cardsim.board.i18n.ts`) cover the cards, zones and actions; these are the
 * room, the rival and the connection. Same rules: picked by the language's first part, English
 * otherwise, single strings overridable.
 */

export interface TableTexts {
  playOnline: string;
  signInToPlay: string;
  gameNotOnline: string;
  yourDecks: string;
  noDecks: string;
  newDeckFromList: string;
  deckName: string;
  saveDeck: string;
  chooseDeck: string;
  createRoom: string;
  roomName: string;
  password: string;
  allowSpectators: string;
  clock: string;
  noClock: string;
  minutes: (n: number) => string;
  bestOf: (n: number) => string;
  create: string;
  joinByCode: string;
  code: string;
  join: string;
  watch: string;
  openRooms: string;
  noOpenRooms: string;
  seatsTaken: (taken: number, total: number) => string;
  locked: string;
  refresh: string;
  backToRooms: string;
  pickDeckFirst: string;

  waitingRival: string;
  roomCode: (code: string) => string;
  copyLink: string;
  copied: string;
  you: string;
  player: (n: number) => string;
  spectating: string;
  live: string;
  reconnecting: string;
  polling: string;
  yourTurn: string;
  turnOf: (who: string) => string;
  askUndo: string;
  undoWaiting: string;
  undoOffered: string;
  accept: string;
  decline: string;
  concede: string;
  youWon: string;
  youLost: string;
  winner: (who: string) => string;
  draw: string;
  timedOut: (who: string) => string;
  rematch: string;
  goToRematch: string;
  shareImages: string;
  nothingToShare: string;
  shared: string;
  offer: (who: string, label: string, host: string) => string;
  addToMine: string;
  ignore: string;
  stale: string;
  offline: string;
  auth: string;
  hiddenCards: (n: number) => string;
}

const es: TableTexts = {
  playOnline: "Jugar contra otra persona",
  signInToPlay: "Inicia sesión para jugar en línea.",
  gameNotOnline: "Este juego aún no está publicado para jugar en línea.",
  yourDecks: "Tus mazos",
  noDecks: "Aún no tienes mazos de este juego.",
  newDeckFromList: "Mazo nuevo desde una lista",
  deckName: "Nombre del mazo",
  saveDeck: "Guardar mazo",
  chooseDeck: "Elige un mazo",
  createRoom: "Crear sala",
  roomName: "Nombre de la sala",
  password: "Contraseña",
  allowSpectators: "Se puede mirar",
  clock: "Reloj",
  noClock: "Sin reloj",
  minutes: (n) => `${n} min`,
  bestOf: (n) => (n === 1 ? "Una partida" : `Al mejor de ${n}`),
  create: "Crear",
  joinByCode: "Entrar con un código",
  code: "Código",
  join: "Sentarse",
  watch: "Mirar",
  openRooms: "Salas abiertas",
  noOpenRooms: "No hay salas abiertas.",
  seatsTaken: (taken, total) => `${taken}/${total} jugadores`,
  locked: "Con contraseña",
  refresh: "Actualizar",
  backToRooms: "Volver a las salas",
  pickDeckFirst: "Elige antes un mazo.",

  waitingRival: "Esperando rival.",
  roomCode: (code) => `Código de la sala: ${code}`,
  copyLink: "Copiar enlace",
  copied: "Copiado.",
  you: "Tú",
  player: (n) => `Jugador ${n}`,
  spectating: "Estás mirando",
  live: "En directo",
  reconnecting: "Reconectando…",
  polling: "Actualizando cada pocos segundos",
  yourTurn: "Tu turno",
  turnOf: (who) => `Turno de ${who}`,
  askUndo: "Pedir deshacer",
  undoWaiting: "Esperando a que el rival acepte deshacer.",
  undoOffered: "El rival pide deshacer la última jugada.",
  accept: "Aceptar",
  decline: "Rechazar",
  concede: "Rendirse",
  youWon: "Has ganado.",
  youLost: "Has perdido.",
  winner: (who) => `Gana ${who}.`,
  draw: "Empate.",
  timedOut: (who) => `A ${who} se le acabó el tiempo.`,
  rematch: "Revancha",
  goToRematch: "Ir a la revancha",
  shareImages: "Compartir mis imágenes",
  nothingToShare: "Solo se pueden compartir plantillas de enlace y paquetes.",
  shared: "Enviado al rival.",
  offer: (who, label, host) => `${who} te ofrece sus imágenes: «${label}» (${host}).`,
  addToMine: "Añadir a mis imágenes",
  ignore: "Ignorar",
  stale: "La mesa cambió mientras jugabas; ya ves cómo está.",
  offline: "Sin conexión.",
  auth: "Tienes que iniciar sesión.",
  hiddenCards: (n) => `${n} ${n === 1 ? "carta oculta" : "cartas ocultas"}`,
};

const en: TableTexts = {
  playOnline: "Play another person",
  signInToPlay: "Sign in to play online.",
  gameNotOnline: "This game is not published for online play yet.",
  yourDecks: "Your decks",
  noDecks: "You have no decks for this game yet.",
  newDeckFromList: "New deck from a list",
  deckName: "Deck name",
  saveDeck: "Save deck",
  chooseDeck: "Choose a deck",
  createRoom: "Create a room",
  roomName: "Room name",
  password: "Password",
  allowSpectators: "Others may watch",
  clock: "Clock",
  noClock: "No clock",
  minutes: (n) => `${n} min`,
  bestOf: (n) => (n === 1 ? "One game" : `Best of ${n}`),
  create: "Create",
  joinByCode: "Join with a code",
  code: "Code",
  join: "Sit down",
  watch: "Watch",
  openRooms: "Open rooms",
  noOpenRooms: "No open rooms.",
  seatsTaken: (taken, total) => `${taken}/${total} players`,
  locked: "Password",
  refresh: "Refresh",
  backToRooms: "Back to the rooms",
  pickDeckFirst: "Choose a deck first.",

  waitingRival: "Waiting for an opponent.",
  roomCode: (code) => `Room code: ${code}`,
  copyLink: "Copy link",
  copied: "Copied.",
  you: "You",
  player: (n) => `Player ${n}`,
  spectating: "You are watching",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Updating every few seconds",
  yourTurn: "Your turn",
  turnOf: (who) => `${who}'s turn`,
  askUndo: "Ask to undo",
  undoWaiting: "Waiting for your opponent to accept the undo.",
  undoOffered: "Your opponent asks to undo the last play.",
  accept: "Accept",
  decline: "Decline",
  concede: "Concede",
  youWon: "You won.",
  youLost: "You lost.",
  winner: (who) => `${who} wins.`,
  draw: "Draw.",
  timedOut: (who) => `${who} ran out of time.`,
  rematch: "Rematch",
  goToRematch: "Go to the rematch",
  shareImages: "Share my images",
  nothingToShare: "Only link templates and packs can be shared.",
  shared: "Sent to your opponent.",
  offer: (who, label, host) => `${who} offers you their images: “${label}” (${host}).`,
  addToMine: "Add to my images",
  ignore: "Ignore",
  stale: "The table changed while you played; this is how it is now.",
  offline: "Offline.",
  auth: "You need to sign in.",
  hiddenCards: (n) => `${n} hidden ${n === 1 ? "card" : "cards"}`,
};

const pt: TableTexts = {
  playOnline: "Jogar contra outra pessoa",
  signInToPlay: "Entre na sua conta para jogar online.",
  gameNotOnline: "Este jogo ainda não está publicado para jogar online.",
  yourDecks: "Seus baralhos",
  noDecks: "Você ainda não tem baralhos deste jogo.",
  newDeckFromList: "Baralho novo a partir de uma lista",
  deckName: "Nome do baralho",
  saveDeck: "Salvar baralho",
  chooseDeck: "Escolha um baralho",
  createRoom: "Criar sala",
  roomName: "Nome da sala",
  password: "Senha",
  allowSpectators: "Outros podem assistir",
  clock: "Relógio",
  noClock: "Sem relógio",
  minutes: (n) => `${n} min`,
  bestOf: (n) => (n === 1 ? "Uma partida" : `Melhor de ${n}`),
  create: "Criar",
  joinByCode: "Entrar com um código",
  code: "Código",
  join: "Sentar",
  watch: "Assistir",
  openRooms: "Salas abertas",
  noOpenRooms: "Não há salas abertas.",
  seatsTaken: (taken, total) => `${taken}/${total} jogadores`,
  locked: "Com senha",
  refresh: "Atualizar",
  backToRooms: "Voltar às salas",
  pickDeckFirst: "Escolha antes um baralho.",

  waitingRival: "Esperando um adversário.",
  roomCode: (code) => `Código da sala: ${code}`,
  copyLink: "Copiar link",
  copied: "Copiado.",
  you: "Você",
  player: (n) => `Jogador ${n}`,
  spectating: "Você está assistindo",
  live: "Ao vivo",
  reconnecting: "Reconectando…",
  polling: "Atualizando a cada poucos segundos",
  yourTurn: "Sua vez",
  turnOf: (who) => `Vez de ${who}`,
  askUndo: "Pedir para desfazer",
  undoWaiting: "Esperando o adversário aceitar desfazer.",
  undoOffered: "O adversário pede para desfazer a última jogada.",
  accept: "Aceitar",
  decline: "Recusar",
  concede: "Desistir",
  youWon: "Você ganhou.",
  youLost: "Você perdeu.",
  winner: (who) => `${who} ganha.`,
  draw: "Empate.",
  timedOut: (who) => `O tempo de ${who} acabou.`,
  rematch: "Revanche",
  goToRematch: "Ir para a revanche",
  shareImages: "Compartilhar minhas imagens",
  nothingToShare: "Só é possível compartilhar modelos de link e pacotes.",
  shared: "Enviado ao adversário.",
  offer: (who, label, host) => `${who} oferece suas imagens: «${label}» (${host}).`,
  addToMine: "Adicionar às minhas imagens",
  ignore: "Ignorar",
  stale: "A mesa mudou enquanto você jogava; agora você vê como está.",
  offline: "Sem conexão.",
  auth: "Você precisa entrar na sua conta.",
  hiddenCards: (n) => `${n} ${n === 1 ? "carta oculta" : "cartas ocultas"}`,
};

export const TABLE_TEXTS = { es, en, pt } as const;

export function tableTexts(lang?: string | null, overrides: Partial<TableTexts> = {}): TableTexts {
  const base = (lang ?? "").toLowerCase().split(/[-_]/)[0] as keyof typeof TABLE_TEXTS;
  return { ...(TABLE_TEXTS[base] ?? en), ...overrides };
}
