-- New real properties join discovery automatically when published.
ALTER TABLE "Property" ADD COLUMN "isTestProperty" BOOLEAN NOT NULL DEFAULT false;

-- One-time classification confirmed by the owner on 2026-10-02.
-- Does not change availability, publication, catalog visibility or robots metadata.
UPDATE "Property" AS p
SET "isTestProperty" = true
FROM "Organization" AS o
WHERE p."organizationId" = o.id
  AND (o.slug, p.slug) IN (
    ('fernandezpropertymanagement', 'casa-collores'),
    ('fernandezpropertymanagement', 'villa-palmas'),
    ('fernandezpropertymanagement', 'villa-demo'),
    ('fernandezpropertymanagement', 'villa-valencia'),
    ('remansodepaz', 'remanso'),
    ('canary', 'Canary')
  );
