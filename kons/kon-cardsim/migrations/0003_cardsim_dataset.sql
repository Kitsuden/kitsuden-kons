-- A game's catalog can come from a CMS dataset
-- ============================================================================
-- Until now cards only came in through the request body, which forced us to
-- keep a second copy of a catalog the team already edits in a dataset. These
-- two columns tie the game to its source.
--
-- Both nullable: a game whose catalog comes from a scraper is still valid and
-- has no dataset to hang from.

ALTER TABLE cardsim_games ADD COLUMN IF NOT EXISTS catalog_dataset_id text;

-- Which dataset field is the `card_id` is NOT guessed: it is the id that saved
-- decks reference, and getting it right "almost always" means that the day it
-- fails there are already decks pointing at the previous id.
ALTER TABLE cardsim_games ADD COLUMN IF NOT EXISTS catalog_id_field text;

CREATE INDEX IF NOT EXISTS cardsim_games_catalog_dataset_idx
  ON cardsim_games (catalog_dataset_id)
  WHERE catalog_dataset_id IS NOT NULL;
