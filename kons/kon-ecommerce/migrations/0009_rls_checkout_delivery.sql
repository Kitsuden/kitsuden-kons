-- 0009 — Row security for the tables of 0008
-- ============================================================================
-- Idempotent: each call drops and recreates its policies.
--
-- Same rule as the orders (0003, 0007), declared with the core's helper (agent-functions.sql):
-- the SYSTEM (no user and no role) and the shop team (admin, editor) read and write; an agent
-- only through the scopes the app grants it. The buyer never reaches these tables with their own
-- identity: the public routes check the order token in the application and then act as the
-- system, which is what keeps one buyer from listing another's license keys.

-- Files a product delivers, and the license-key pool: the catalog's team.
SELECT kitsuden_rls_team('shop_product_files', 'ecommerce', NULL, 'shop-product:update');
SELECT kitsuden_rls_team('shop_license_keys', 'ecommerce', NULL, 'shop-product:update');

-- What paid orders delivered: whoever operates orders.
SELECT kitsuden_rls_team('shop_entitlements', 'ecommerce', 'shop-order:view', 'shop-order:update');

-- Discount codes.
SELECT kitsuden_rls_team('shop_promotions', 'ecommerce', 'shop-promotion:view', 'shop-promotion:update');

-- "My orders" links: no agent scope. A link is the buyer's; nobody else needs to read it.
SELECT kitsuden_rls_team('shop_order_links', 'ecommerce', NULL, NULL);
