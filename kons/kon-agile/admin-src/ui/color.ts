/**
 * A colour token of the kit ("--ta-accent") as the `#rrggbb` a colour field takes, read where
 * the theme applies (an element inside the view's ThemeScope). The default colour of something
 * new comes from the theme this way, never from a literal in the code.
 *
 * "" when it cannot be read: the caller then leaves the colour out of the request and the API's
 * own default applies.
 */
export function tokenHex(scope: Element | null | undefined, token: string): string {
  if (!scope) return "";
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = `rgb(var(${token}))`;
  scope.append(probe);
  const parts = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  if (!parts || parts.length < 3) return "";
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.min(255, Math.round(Number(n))).toString(16).padStart(2, "0"))
    .join("")}`;
}
