/**
 * tallao — component texts
 *
 * The texts the kit adds on its own (accessible names of buttons, "no results",
 * the states of a tool call…) come from here. English by default; `es` is
 * included. For a whole application (or part of one), in the root component:
 *
 *   import { setLabels, es } from "tallao";
 *   setLabels(es);                        // or setLabels({ ...es, close: "Salir" })
 *
 * An explicit prop (`closeLabel`, `emptyText`…) still takes precedence over this.
 */
import { getContext, setContext } from "svelte";

export interface Labels {
  close: string;
  cancel: string;
  confirm: string;
  dismiss: string;
  noResults: string;
  send: string;
  attach: string;
  promptPlaceholder: string;
  approve: string;
  reject: string;
  pending: string;
  running: string;
  done: string;
  rejected: string;
  failed: string;
  arguments: string;
  result: string;
  map: string;
  notifications: string;
  loading: string;
  search: string;
  commandPalette: string;
  remove: string;
  previous: string;
  next: string;
  pagination: string;
  page: string;
  rowsPerPage: string;
  selectRow: string;
  selectAll: string;
  today: string;
  chooseDate: string;
  previousMonth: string;
  nextMonth: string;
  chooseFiles: string;
  dropFiles: string;
  actions: string;
  breadcrumb: string;
  resize: string;
  navigation: string;
  collapse: string;
  expand: string;
  showData: string;
  hideData: string;
  codeEditor: string;
  required: string;
  invalid: string;
  submit: string;
  clear: string;
  decrement: string;
  increment: string;
  /** "{n} of {total}" (stars). */
  ratingOf: string;
  /** Name of the carousel when none is given. */
  carousel: string;
  /** What it is (aria-roledescription): the carousel and each slide. */
  carouselRole: string;
  slideRole: string;
  /** "{n} of {total}" (slides). */
  slideOf: string;
  stopRotation: string;
  startRotation: string;
  /** Name of the before / after slider. */
  compareSlider: string;
  before: string;
  after: string;
  /** Copy button (CodeBlock) and the notice after copying. */
  copy: string;
  copied: string;
  /** Accessible name of the list of a plan's steps (Steps). */
  planSteps: string;
  /** "Skipped" state of a step (Steps). */
  skipped: string;
  /** Accessible name of the suggestion group (SuggestionChips). */
  suggestions: string;
  /** Accessible name of the source list (Sources). */
  sources: string;
  /** Label for quota usage (UsageMeter). */
  usage: string;
  /** Accessible name of a one-time code field (InputOTP). */
  oneTimeCode: string;
  /** "{n} of {total}" position of the current slot (InputOTP). */
  otpDigit: string;
  /** Accessible name of a column filter: "{column}" is replaced (DataTable). */
  filterColumn: string;
  /** Lower and upper bound of a range filter (DataTable). */
  minimum: string;
  maximum: string;
  /** Empty option of a select filter (DataTable). */
  allValues: string;
  /** Button that resets every column filter (DataTable). */
  clearFilters: string;
  /** Empty row when the filters leave nothing (DataTable). */
  noMatches: string;
  /** A navigation entry that is not available yet (NavMenu). */
  comingSoon: string;
}

export const en: Labels = {
  close: "Close",
  cancel: "Cancel",
  confirm: "Confirm",
  dismiss: "Dismiss",
  noResults: "No results",
  send: "Send message",
  attach: "Attach file",
  promptPlaceholder: "Write a message…",
  approve: "Approve",
  reject: "Reject",
  pending: "Pending",
  running: "Running…",
  done: "Done",
  rejected: "Rejected",
  failed: "Failed",
  arguments: "Arguments",
  result: "Result",
  map: "Map",
  notifications: "Notifications",
  loading: "Loading",
  search: "Search…",
  commandPalette: "Command palette",
  remove: "Remove",
  previous: "Previous",
  next: "Next",
  pagination: "Pagination",
  page: "Page",
  rowsPerPage: "Rows per page",
  selectRow: "Select row",
  selectAll: "Select all",
  today: "Today",
  chooseDate: "Choose date",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  chooseFiles: "Choose files",
  dropFiles: "or drop them here",
  actions: "Actions",
  breadcrumb: "Breadcrumb",
  resize: "Resize",
  navigation: "Navigation",
  collapse: "Collapse",
  expand: "Expand",
  showData: "Show data",
  hideData: "Hide data",
  codeEditor: "Code editor",
  required: "Required",
  invalid: "Invalid value",
  submit: "Save",
  clear: "Clear",
  decrement: "Decrease",
  increment: "Increase",
  ratingOf: "{n} of {total}",
  carousel: "Carousel",
  carouselRole: "carousel",
  slideRole: "slide",
  slideOf: "{n} of {total}",
  stopRotation: "Stop slide rotation",
  startRotation: "Start slide rotation",
  compareSlider: "Comparison slider",
  before: "Before",
  after: "After",
  copy: "Copy",
  copied: "Copied",
  planSteps: "Plan steps",
  skipped: "Skipped",
  suggestions: "Suggestions",
  sources: "Sources",
  usage: "Usage",
  oneTimeCode: "One-time code",
  otpDigit: "Digit {n} of {total}",
  filterColumn: "Filter {column}",
  minimum: "Minimum",
  maximum: "Maximum",
  allValues: "All",
  clearFilters: "Clear filters",
  noMatches: "No rows match the filters",
  comingSoon: "Coming soon",
};

export const es: Labels = {
  close: "Cerrar",
  cancel: "Cancelar",
  confirm: "Confirmar",
  dismiss: "Descartar",
  noResults: "Sin resultados",
  send: "Enviar mensaje",
  attach: "Adjuntar archivo",
  promptPlaceholder: "Escribe un mensaje…",
  approve: "Aprobar",
  reject: "Rechazar",
  pending: "Pendiente",
  running: "Ejecutando…",
  done: "Ejecutado",
  rejected: "Rechazado",
  failed: "Fallido",
  arguments: "Argumentos",
  result: "Resultado",
  map: "Mapa",
  notifications: "Notificaciones",
  loading: "Cargando",
  search: "Buscar…",
  commandPalette: "Paleta de órdenes",
  remove: "Quitar",
  previous: "Anterior",
  next: "Siguiente",
  pagination: "Paginación",
  page: "Página",
  rowsPerPage: "Filas por página",
  selectRow: "Seleccionar fila",
  selectAll: "Seleccionar todo",
  today: "Hoy",
  chooseDate: "Elegir fecha",
  previousMonth: "Mes anterior",
  nextMonth: "Mes siguiente",
  chooseFiles: "Elegir archivos",
  dropFiles: "o suéltalos aquí",
  actions: "Acciones",
  breadcrumb: "Ruta de navegación",
  resize: "Redimensionar",
  navigation: "Navegación",
  collapse: "Contraer",
  expand: "Expandir",
  showData: "Ver datos",
  hideData: "Ocultar datos",
  codeEditor: "Editor de código",
  required: "Obligatorio",
  invalid: "Valor no válido",
  submit: "Guardar",
  clear: "Borrar",
  decrement: "Restar",
  increment: "Sumar",
  ratingOf: "{n} de {total}",
  carousel: "Carrusel",
  carouselRole: "carrusel",
  slideRole: "diapositiva",
  slideOf: "{n} de {total}",
  stopRotation: "Detener el paso automático",
  startRotation: "Reanudar el paso automático",
  compareSlider: "Control deslizante de comparación",
  before: "Antes",
  after: "Después",
  copy: "Copiar",
  copied: "Copiado",
  planSteps: "Pasos del plan",
  skipped: "Saltado",
  suggestions: "Sugerencias",
  sources: "Fuentes",
  usage: "Uso",
  oneTimeCode: "Código de un solo uso",
  otpDigit: "Dígito {n} de {total}",
  filterColumn: "Filtrar {column}",
  minimum: "Mínimo",
  maximum: "Máximo",
  allValues: "Todos",
  clearFilters: "Quitar filtros",
  noMatches: "Ninguna fila cumple los filtros",
  comingSoon: "Próximamente",
};

const KEY = Symbol("tallao-labels");

/** Texts for this component and everything below it (merged with the inherited ones). */
export function setLabels(labels: Partial<Labels>): Labels {
  const merged = { ...useLabels(), ...labels };
  setContext(KEY, merged);
  return merged;
}

/** What applies without a setLabels above: English, unless changed with setDefaultLabels. */
let defaults: Labels = en;

/**
 * Changes the starting texts of the whole kit, without context: for pages where each
 * component is its own root (Astro islands, for example) and there is no component
 * above to call setLabels in. setLabels still takes precedence over this.
 *
 * It is module state: on the server every request shares it, so with more than one
 * language call it only in the browser.
 */
export function setDefaultLabels(labels: Partial<Labels>): Labels {
  defaults = { ...en, ...labels };
  return defaults;
}

/** The current texts: those an ancestor set with setLabels, or the starting ones. */
export function useLabels(): Labels {
  return getContext<Labels | undefined>(KEY) ?? defaults;
}
