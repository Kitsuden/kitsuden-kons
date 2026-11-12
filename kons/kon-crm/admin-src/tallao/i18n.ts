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
  /** Empty state of a chart or data block with nothing to show. */
  noData: string;
  /** The slice that groups what does not fit (DonutChart). */
  other: string;
  /** Sum of the values (DonutChart centre, stacked charts). */
  total: string;
  /** "Source" before a chart's source (ChartCard). */
  source: string;
  /** "Target" before a goal value (KpiCard, Gauge). */
  target: string;
  /** Direction of a change, read by screen readers (KpiCard). */
  trendUp: string;
  trendDown: string;
  trendFlat: string;
  /** Meaning of a change, independent of its direction (KpiCard). */
  better: string;
  worse: string;
  /** "{n} of {total}" (IconArray). */
  countOf: string;
  /** A trend in words: "{first}", "{last}", "{min}", "{max}" are replaced (Sparkline). */
  trendSummary: string;
  /** "{percent} of the previous step" (Funnel). */
  ofPreviousStep: string;
  /** Column headers of the data table (ScatterChart). */
  label: string;
  group: string;
  /** Accessible name of the filter bar (FilterBar). */
  filters: string;
  /** Menu with the filters that are not shown yet (FilterBar). */
  addFilter: string;
  /** Button that empties the search and every filter (FilterBar). */
  clearAll: string;
  /** How many filters apply, for screen readers: "{n}" is replaced (FilterBar). */
  noActiveFilters: string;
  activeFilterOne: string;
  activeFilters: string;
  /** Button that removes one filter: "{filter}" is replaced (FilterChip). */
  removeFilter: string;
  /** Values of a boolean filter (FilterChip). */
  yes: string;
  no: string;
  /** Default titles of an empty state, by variant (EmptyState). */
  emptyTitle: string;
  noResultsTitle: string;
  errorTitle: string;
  /** Button that repeats a failed load (EmptyState). */
  retry: string;
  /** States of a form (SaveBar). */
  unsavedChanges: string;
  saving: string;
  /** Accessible name of the bar (SaveBar). */
  formActions: string;
  /** Accessible name of a list of field changes (DiffView). */
  changes: string;
  /** Kind of a field change (DiffView). */
  added: string;
  removed: string;
  changed: string;
  /** Empty state of a diff (DiffView). */
  noChanges: string;
  /** A value that is not there, in words (DiffView). */
  emptyValue: string;
  /** A secret value that is not shown (DiffView). */
  redacted: string;
  /** Buttons that unfold and fold a long value (DiffView). */
  showMore: string;
  showLess: string;
  /** Names of the modifier keys drawn as symbols on a Mac (Kbd). */
  keyCommand: string;
  keyOption: string;
  keyShift: string;
  keyControl: string;
  /** Toolbar toggle for the row density (DataTable). */
  compactRows: string;
  /** Menu that shows and hides columns (DataTable). */
  columns: string;
  /** Menu of named views and its entries: "{name}" is replaced (SavedViews). */
  savedViews: string;
  saveView: string;
  renameView: string;
  deleteView: string;
  deleteViewConfirm: string;
  viewName: string;
  noSavedViews: string;
  delete: string;
  /** Menu button and skip link of the application layout (AppShell). */
  openNavigation: string;
  skipToContent: string;
  /** A model's reasoning while it runs, and once it is done: "{time}" is replaced (Thinking). */
  thinking: string;
  thoughtFor: string;
  /** A duration in words: "{n}", "{m}" and "{s}" are replaced (Thinking, TaskList). */
  secondsShort: string;
  minutesShort: string;
  /** Header of a run of tool calls: "{n}" is replaced (ToolChips). */
  toolCallOne: string;
  toolCalls: string;
  messageOne: string;
  messages: string;
  /** Diff statistics of a file, read by screen readers: "{n}" is replaced (ToolChips). */
  linesAdded: string;
  linesRemoved: string;
  /** Accessible name of a task list and its summary: "{done}" and "{total}" are replaced (TaskList). */
  tasks: string;
  tasksDone: string;
  /** Button that unfolds the details of a row (TaskList, ToolChips). */
  details: string;
  /** Human-in-the-loop request and its outcome (ApprovalCard). */
  approvalRequested: string;
  approved: string;
  editFirst: string;
  expired: string;
  /** Risk level of what is asked (ApprovalCard). */
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  /** Accessible name of what the model was given, and the button that removes one item: "{item}" is replaced (ContextCards). */
  context: string;
  removeItem: string;
  /** How sure a suggestion is (RecommendationCard). */
  confidenceLow: string;
  confidenceMedium: string;
  confidenceHigh: string;
  /** Heading of the reasons behind a suggestion (RecommendationCard). */
  reasons: string;
  /** Ends of the shade scale of a calendar heatmap (CalendarHeatmap). */
  less: string;
  more: string;
  /** The two fields of a date range, its button and its quick ranges: "{n}" is replaced (DateRangePicker). */
  startDate: string;
  endDate: string;
  chooseDates: string;
  lastDays: string;
  thisMonth: string;
  /** Accessible name of a stack of cards (CardStack). */
  cards: string;
  /** Column headers of the data table of a flow chart (SankeyChart). */
  from: string;
  to: string;
  value: string;
  /** Note under a flow chart: "{n}" is replaced (SankeyChart). */
  flowsNotDrawn: string;
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
  noData: "No data",
  other: "Other",
  total: "Total",
  source: "Source",
  target: "Target",
  trendUp: "up",
  trendDown: "down",
  trendFlat: "no change",
  better: "better",
  worse: "worse",
  countOf: "{n} of {total}",
  trendSummary: "from {first} to {last}, low {min}, high {max}",
  ofPreviousStep: "{percent} of the previous step",
  label: "Label",
  group: "Group",
  filters: "Filters",
  addFilter: "Add filter",
  clearAll: "Clear all",
  noActiveFilters: "No filters active",
  activeFilterOne: "1 filter active",
  activeFilters: "{n} filters active",
  removeFilter: "Remove filter: {filter}",
  yes: "Yes",
  no: "No",
  emptyTitle: "Nothing here yet",
  noResultsTitle: "No results for these filters",
  errorTitle: "Something went wrong",
  retry: "Retry",
  unsavedChanges: "Unsaved changes",
  saving: "Saving…",
  formActions: "Form actions",
  changes: "Changes",
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  noChanges: "No changes",
  emptyValue: "empty",
  redacted: "hidden",
  showMore: "Show more",
  showLess: "Show less",
  keyCommand: "Command",
  keyOption: "Option",
  keyShift: "Shift",
  keyControl: "Control",
  compactRows: "Compact rows",
  columns: "Columns",
  savedViews: "Views",
  saveView: "Save current view…",
  renameView: "Rename “{name}”…",
  deleteView: "Delete “{name}”",
  deleteViewConfirm: "Delete the view “{name}”?",
  viewName: "View name",
  noSavedViews: "No saved views",
  delete: "Delete",
  openNavigation: "Open navigation",
  skipToContent: "Skip to content",
  thinking: "Thinking…",
  thoughtFor: "Thought for {time}",
  secondsShort: "{n} s",
  minutesShort: "{m} min {s} s",
  toolCallOne: "1 tool call",
  toolCalls: "{n} tool calls",
  messageOne: "1 message",
  messages: "{n} messages",
  linesAdded: "{n} lines added",
  linesRemoved: "{n} lines removed",
  tasks: "Tasks",
  tasksDone: "{done} of {total} done",
  details: "Details",
  approvalRequested: "Approval requested",
  approved: "Approved",
  editFirst: "Edit first",
  expired: "Expired",
  riskLow: "Low risk",
  riskMedium: "Medium risk",
  riskHigh: "High risk",
  context: "Context",
  removeItem: "Remove {item}",
  confidenceLow: "Low confidence",
  confidenceMedium: "Medium confidence",
  confidenceHigh: "High confidence",
  reasons: "Why",
  less: "Less",
  more: "More",
  startDate: "Start date",
  endDate: "End date",
  chooseDates: "Choose dates",
  lastDays: "Last {n} days",
  thisMonth: "This month",
  cards: "Cards",
  from: "From",
  to: "To",
  value: "Value",
  flowsNotDrawn: "{n} not drawn: it would close a loop",
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
  noData: "Sin datos",
  other: "Otros",
  total: "Total",
  source: "Fuente",
  target: "Objetivo",
  trendUp: "sube",
  trendDown: "baja",
  trendFlat: "sin cambios",
  better: "mejor",
  worse: "peor",
  countOf: "{n} de {total}",
  trendSummary: "de {first} a {last}, mínimo {min}, máximo {max}",
  ofPreviousStep: "{percent} del paso anterior",
  label: "Etiqueta",
  group: "Grupo",
  filters: "Filtros",
  addFilter: "Añadir filtro",
  clearAll: "Quitar todo",
  noActiveFilters: "Ningún filtro activo",
  activeFilterOne: "1 filtro activo",
  activeFilters: "{n} filtros activos",
  removeFilter: "Quitar filtro: {filter}",
  yes: "Sí",
  no: "No",
  emptyTitle: "Aún no hay nada",
  noResultsTitle: "Ningún resultado con estos filtros",
  errorTitle: "Algo ha fallado",
  retry: "Reintentar",
  unsavedChanges: "Cambios sin guardar",
  saving: "Guardando…",
  formActions: "Acciones del formulario",
  changes: "Cambios",
  added: "Añadido",
  removed: "Eliminado",
  changed: "Modificado",
  noChanges: "Sin cambios",
  emptyValue: "vacío",
  redacted: "oculto",
  showMore: "Ver más",
  showLess: "Ver menos",
  keyCommand: "Comando",
  keyOption: "Opción",
  keyShift: "Mayúsculas",
  keyControl: "Control",
  compactRows: "Filas compactas",
  columns: "Columnas",
  savedViews: "Vistas",
  saveView: "Guardar la vista actual…",
  renameView: "Renombrar «{name}»…",
  deleteView: "Eliminar «{name}»",
  deleteViewConfirm: "¿Eliminar la vista «{name}»?",
  viewName: "Nombre de la vista",
  noSavedViews: "No hay vistas guardadas",
  delete: "Eliminar",
  openNavigation: "Abrir la navegación",
  skipToContent: "Saltar al contenido",
  thinking: "Pensando…",
  thoughtFor: "Pensó durante {time}",
  secondsShort: "{n} s",
  minutesShort: "{m} min {s} s",
  toolCallOne: "1 llamada a herramienta",
  toolCalls: "{n} llamadas a herramientas",
  messageOne: "1 mensaje",
  messages: "{n} mensajes",
  linesAdded: "{n} líneas añadidas",
  linesRemoved: "{n} líneas eliminadas",
  tasks: "Tareas",
  tasksDone: "{done} de {total} hechas",
  details: "Detalles",
  approvalRequested: "Aprobación solicitada",
  approved: "Aprobado",
  editFirst: "Editar antes",
  expired: "Caducado",
  riskLow: "Riesgo bajo",
  riskMedium: "Riesgo medio",
  riskHigh: "Riesgo alto",
  context: "Contexto",
  removeItem: "Quitar {item}",
  confidenceLow: "Confianza baja",
  confidenceMedium: "Confianza media",
  confidenceHigh: "Confianza alta",
  reasons: "Por qué",
  less: "Menos",
  more: "Más",
  startDate: "Fecha inicial",
  endDate: "Fecha final",
  chooseDates: "Elegir fechas",
  lastDays: "Últimos {n} días",
  thisMonth: "Este mes",
  cards: "Tarjetas",
  from: "Desde",
  to: "Hasta",
  value: "Valor",
  flowsNotDrawn: "{n} sin dibujar: cerraría un ciclo",
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
