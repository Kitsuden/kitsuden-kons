/**
 * Chat — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "chat" policy.
 *
 * Talking to a team bot is for the team (admin and editor). Setting bots up, adding what they know and reading
 * everyone's conversations is for admins. Agents do not chat with bots: they have the tools directly over MCP.
 * Public bots are reached through `/public/…` routes, which declare `access: "public"` and need no policy.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

const team = (user: AuthzUser | null) => user?.role === "admin" || user?.role === "editor";

export function registerChatPolicy(): void {
  definePolicy("chat", {
    use: (user) => team(user),
    configure: (user) => user?.role === "admin",
  });
}

registerChatPolicy();
