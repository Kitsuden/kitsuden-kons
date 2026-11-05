-- Migration: Media Integration for kon-crm
-- Changes company.logo and contact.avatar from text URLs to media UUID references

-- ============================================
-- COMPANIES: Change logo (text) to logo_id (uuid)
-- ============================================

-- First, drop any existing logo data (migration from text URL to media reference)
-- Note: Existing logo URLs will be lost and need to be re-uploaded via kon-media
ALTER TABLE "crm_companies" DROP COLUMN IF EXISTS "logo";

-- Add logo_id as UUID reference to kon-media
ALTER TABLE "crm_companies" ADD COLUMN "logo_id" UUID;

-- Add index for faster lookups by logo
CREATE INDEX "idx_crm_companies_logo_id" ON "crm_companies"("logo_id");

-- ============================================
-- CONTACTS: Change avatar (text) to avatar_id (uuid)
-- ============================================

-- First, drop any existing avatar data (migration from text URL to media reference)
-- Note: Existing avatar URLs will be lost and need to be re-uploaded via kon-media
ALTER TABLE "crm_contacts" DROP COLUMN IF EXISTS "avatar";

-- Add avatar_id as UUID reference to kon-media
ALTER TABLE "crm_contacts" ADD COLUMN "avatar_id" UUID;

-- Add index for faster lookups by avatar
CREATE INDEX "idx_crm_contacts_avatar_id" ON "crm_contacts"("avatar_id");
