/**
 * tallao — what DropdownMenu and ContextMenu share
 *
 * The context that MenuItem and friends read (close the menu on selection) and the
 * menu keyboard: ↑ ↓ with wrap-around, Home and End, type-ahead by letter and Tab
 * to leave. Disabled items are skipped.
 */
import { getContext, setContext } from "svelte";

const KEY = Symbol("tallao-menu");

export interface MenuContext {
  /** Closes the menu and returns focus to where it was. */
  close: () => void;
}

export const provideMenu = (ctx: MenuContext) => setContext(KEY, ctx);
export const useMenu = () => getContext<MenuContext | undefined>(KEY);

/** Selectable menu items, in order. */
export function menuItems(list: HTMLElement | undefined): HTMLElement[] {
  return list ? [...list.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')] : [];
}

export function focusItem(list: HTMLElement | undefined, index: number) {
  const items = menuItems(list);
  if (items.length) items[(index + items.length) % items.length].focus();
}

/** Keyboard inside the menu; `onTab` closes without returning focus (Tab goes on its way). */
export function menuKeyboard(onTab: () => void) {
  let query = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  return (e: KeyboardEvent, list: HTMLElement | undefined) => {
    const items = menuItems(list);
    const i = items.indexOf(e.target as HTMLElement);
    if (e.key === "ArrowDown") focusItem(list, i + 1);
    else if (e.key === "ArrowUp") focusItem(list, i - 1);
    else if (e.key === "Home") focusItem(list, 0);
    else if (e.key === "End") focusItem(list, -1);
    else if (e.key === "Tab") {
      onTab();
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Letters typed in quick succession form the prefix being searched for.
      clearTimeout(timer);
      query += e.key.toLowerCase();
      timer = setTimeout(() => (query = ""), 500);
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      order.find((el) => el.textContent?.trim().toLowerCase().startsWith(query))?.focus();
    } else return;
    e.preventDefault();
  };
}
