-- kon-dc — a server's language (Discord's preferred locale), for what the bot says on its own:
-- level-ups, giveaway winners, birthdays, alerts. Interactions use each member's own locale.

ALTER TABLE dc_guilds ADD COLUMN IF NOT EXISTS locale varchar(10);
