/**
 * What the view keeps while it stays open: the tab, the server picked and its tab. Switching
 * from Servers to Blueprints and back lands where you were, not on the first server
 * (state-preservation). Kept for the page's life only; nothing goes to storage.
 */
export const remembered = $state({ tab: "overview", guildId: "", serverTab: "modules" });
