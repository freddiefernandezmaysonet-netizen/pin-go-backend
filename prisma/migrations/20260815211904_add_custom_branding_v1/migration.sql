-- Pin&Go Enterprise — Custom Branding V1
-- Additive organization-level branding, domains, revisions and secure invitations.
-- No backfill and no changes to existing organizations.

BEGIN;

-- CreateEnum
CREATE TYPE "BrandExperienceType" AS ENUM ('STANDARD', 'ENTERPRISE_BRANDED');

-- CreateEnum
CREATE TYPE "BrandProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "BrandRevisionApprovalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BrandDomainType" AS ENUM ('PINNGO_SUBDOMAIN', 'CUSTOM_DOMAIN');

-- CreateEnum
CREATE TYPE "BrandDomainStatus" AS ENUM ('PENDING_CONFIGURATION', 'PENDING_DNS', 'VERIFYING', 'ACTIVE', 'FAILED', 'RETIRED');

-- CreateEnum
CREATE TYPE "BrandDomainProvider" AS ENUM ('VERCEL');

-- CreateTable
CREATE TABLE "BrandProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "experienceType" "BrandExperienceType" NOT NULL DEFAULT 'STANDARD',
    "status" "BrandProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "activeRevisionId" TEXT,
    "activeDomainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandRevision" (
    "id" TEXT NOT NULL,
    "brandProfileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "logoPublicId" TEXT NOT NULL,
    "faviconUrl" TEXT NOT NULL,
    "faviconPublicId" TEXT NOT NULL,
    "primaryColor" VARCHAR(7) NOT NULL,
    "approvalStatus" "BrandRevisionApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandDomain" (
    "id" TEXT NOT NULL,
    "brandProfileId" TEXT NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "type" "BrandDomainType" NOT NULL,
    "status" "BrandDomainStatus" NOT NULL DEFAULT 'PENDING_CONFIGURATION',
    "provider" "BrandDomainProvider" NOT NULL DEFAULT 'VERCEL',
    "providerDomainId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "redirectUntil" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "DashboardUserRole" NOT NULL DEFAULT 'ORG_ADMIN',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "acceptedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandProfile_organizationId_key" ON "BrandProfile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandProfile_activeRevisionId_key" ON "BrandProfile"("activeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandProfile_activeDomainId_key" ON "BrandProfile"("activeDomainId");

-- CreateIndex
CREATE INDEX "BrandProfile_experienceType_status_idx" ON "BrandProfile"("experienceType", "status");

-- CreateIndex
CREATE INDEX "BrandRevision_brandProfileId_approvalStatus_idx" ON "BrandRevision"("brandProfileId", "approvalStatus");

-- CreateIndex
CREATE INDEX "BrandRevision_createdByUserId_idx" ON "BrandRevision"("createdByUserId");

-- CreateIndex
CREATE INDEX "BrandRevision_approvedByUserId_idx" ON "BrandRevision"("approvedByUserId");

-- CreateIndex
CREATE INDEX "BrandRevision_rejectedByUserId_idx" ON "BrandRevision"("rejectedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandRevision_brandProfileId_version_key" ON "BrandRevision"("brandProfileId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BrandDomain_hostname_key" ON "BrandDomain"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "BrandDomain_providerDomainId_key" ON "BrandDomain"("providerDomainId");

-- CreateIndex
CREATE INDEX "BrandDomain_brandProfileId_status_idx" ON "BrandDomain"("brandProfileId", "status");

-- CreateIndex
CREATE INDEX "BrandDomain_createdByUserId_idx" ON "BrandDomain"("createdByUserId");

-- CreateIndex
CREATE INDEX "BrandDomain_status_redirectUntil_idx" ON "BrandDomain"("status", "redirectUntil");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_email_idx" ON "OrganizationInvitation"("organizationId", "email");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_expiresAt_idx" ON "OrganizationInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_createdByUserId_idx" ON "OrganizationInvitation"("createdByUserId");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_acceptedUserId_idx" ON "OrganizationInvitation"("acceptedUserId");

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_activeRevisionId_fkey" FOREIGN KEY ("activeRevisionId") REFERENCES "BrandRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_activeDomainId_fkey" FOREIGN KEY ("activeDomainId") REFERENCES "BrandDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRevision" ADD CONSTRAINT "BrandRevision_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRevision" ADD CONSTRAINT "BrandRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRevision" ADD CONSTRAINT "BrandRevision_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRevision" ADD CONSTRAINT "BrandRevision_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandDomain" ADD CONSTRAINT "BrandDomain_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandDomain" ADD CONSTRAINT "BrandDomain_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "DashboardUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
