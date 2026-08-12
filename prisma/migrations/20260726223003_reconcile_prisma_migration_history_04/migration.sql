-- Pin&Go Prisma migration-history reconciliation
-- Part 4 of 5. All missing unique and non-unique indexes.
-- Do not apply to an existing database unless the schema-equivalence preflight has passed.

BEGIN;
-- CreateIndex
CREATE UNIQUE INDEX "DashboardUser_email_key" ON "DashboardUser"("email");

-- CreateIndex
CREATE INDEX "DashboardUser_organizationId_isActive_idx" ON "DashboardUser"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "DashboardUser_organizationId_role_idx" ON "DashboardUser"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "PasswordResetSmsCode_userId_idx" ON "PasswordResetSmsCode"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetSmsCode_phone_idx" ON "PasswordResetSmsCode"("phone");

-- CreateIndex
CREATE INDEX "PasswordResetSmsCode_expiresAt_idx" ON "PasswordResetSmsCode"("expiresAt");

-- CreateIndex
CREATE INDEX "PropertyNightlyRate_propertyId_date_idx" ON "PropertyNightlyRate"("propertyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyNightlyRate_propertyId_date_key" ON "PropertyNightlyRate"("propertyId", "date");

-- CreateIndex
CREATE INDEX "PropertySeason_propertyId_idx" ON "PropertySeason"("propertyId");

-- CreateIndex
CREATE INDEX "PropertySeason_propertyId_isActive_idx" ON "PropertySeason"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "PropertySeason_propertyId_source_idx" ON "PropertySeason"("propertyId", "source");

-- CreateIndex
CREATE INDEX "PropertySeason_type_idx" ON "PropertySeason"("type");

-- CreateIndex
CREATE INDEX "MarketSeasonTemplate_country_idx" ON "MarketSeasonTemplate"("country");

-- CreateIndex
CREATE INDEX "MarketSeasonTemplate_country_isActive_idx" ON "MarketSeasonTemplate"("country", "isActive");

-- CreateIndex
CREATE INDEX "MarketSeasonTemplate_country_region_idx" ON "MarketSeasonTemplate"("country", "region");

-- CreateIndex
CREATE INDEX "MarketSeasonTemplate_type_idx" ON "MarketSeasonTemplate"("type");

-- CreateIndex
CREATE INDEX "PropertyHolidayPricing_propertyId_idx" ON "PropertyHolidayPricing"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyHolidayPricing_propertyId_isActive_idx" ON "PropertyHolidayPricing"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "PropertyHolidayPricing_propertyId_source_idx" ON "PropertyHolidayPricing"("propertyId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "PendingSignup_stripeCheckoutSessionId_key" ON "PendingSignup"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "PendingSignup_email_idx" ON "PendingSignup"("email");

-- CreateIndex
CREATE INDEX "PendingSignup_status_idx" ON "PendingSignup"("status");

-- CreateIndex
CREATE INDEX "PendingSignup_stripeCustomerId_idx" ON "PendingSignup"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "PendingSignup_stripeSubscriptionId_idx" ON "PendingSignup"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestJourney_reservationId_key" ON "GuestJourney"("reservationId");

-- CreateIndex
CREATE INDEX "GuestJourney_currentState_idx" ON "GuestJourney"("currentState");

-- CreateIndex
CREATE INDEX "GuestJourney_stateChangedAt_idx" ON "GuestJourney"("stateChangedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceHealth_lockId_key" ON "DeviceHealth"("lockId");

-- CreateIndex
CREATE INDEX "DeviceHealth_organizationId_idx" ON "DeviceHealth"("organizationId");

-- CreateIndex
CREATE INDEX "DeviceHealth_propertyId_idx" ON "DeviceHealth"("propertyId");

-- CreateIndex
CREATE INDEX "DeviceHealth_healthStatus_idx" ON "DeviceHealth"("healthStatus");

-- CreateIndex
CREATE INDEX "DeviceHealth_operationalRisk_idx" ON "DeviceHealth"("operationalRisk");

-- CreateIndex
CREATE INDEX "DeviceHealth_lastSeenAt_idx" ON "DeviceHealth"("lastSeenAt");

-- CreateIndex
CREATE INDEX "DeviceHealth_nextCheckInAt_idx" ON "DeviceHealth"("nextCheckInAt");

-- CreateIndex
CREATE INDEX "DeviceHealth_batteryNextCheckAt_idx" ON "DeviceHealth"("batteryNextCheckAt");

-- CreateIndex
CREATE INDEX "DeviceHealth_gatewayNextCheckAt_idx" ON "DeviceHealth"("gatewayNextCheckAt");

-- CreateIndex
CREATE INDEX "DeviceHealth_gatewayCheckReservationId_idx" ON "DeviceHealth"("gatewayCheckReservationId");

-- CreateIndex
CREATE INDEX "DeviceHealth_gatewayCriticalAlertReservationId_gatewayCriti_idx" ON "DeviceHealth"("gatewayCriticalAlertReservationId", "gatewayCriticalAlertStatus");

-- CreateIndex
CREATE INDEX "MessageDispatchLog_reservationId_type_idx" ON "MessageDispatchLog"("reservationId", "type");

-- CreateIndex
CREATE INDEX "PropertyStaff_propertyId_idx" ON "PropertyStaff"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyStaff_staffMemberId_idx" ON "PropertyStaff"("staffMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyStaff_propertyId_staffMemberId_key" ON "PropertyStaff"("propertyId", "staffMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "CleaningConfirmation_token_key" ON "CleaningConfirmation"("token");

-- CreateIndex
CREATE INDEX "PmsConnection_organizationId_provider_idx" ON "PmsConnection"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PmsConnection_organizationId_provider_key" ON "PmsConnection"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "PmsListing_connectionId_idx" ON "PmsListing"("connectionId");

-- CreateIndex
CREATE INDEX "PmsListing_propertyId_idx" ON "PmsListing"("propertyId");

-- CreateIndex
CREATE INDEX "PmsListing_lockId_idx" ON "PmsListing"("lockId");

-- CreateIndex
CREATE UNIQUE INDEX "PmsListing_connectionId_externalListingId_key" ON "PmsListing"("connectionId", "externalListingId");

-- CreateIndex
CREATE INDEX "PmsReservationLink_reservationId_idx" ON "PmsReservationLink"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "PmsReservationLink_connectionId_externalReservationId_key" ON "PmsReservationLink"("connectionId", "externalReservationId");

-- CreateIndex
CREATE INDEX "WebhookEventIngest_connectionId_status_idx" ON "WebhookEventIngest"("connectionId", "status");

-- CreateIndex
CREATE INDEX "WebhookEventIngest_provider_idx" ON "WebhookEventIngest"("provider");

-- CreateIndex
CREATE INDEX "WebhookEventIngest_receivedAt_idx" ON "WebhookEventIngest"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEventIngest_connectionId_externalEventId_key" ON "WebhookEventIngest"("connectionId", "externalEventId");

-- CreateIndex
CREATE INDEX "PropertyDevice_organizationId_propertyId_idx" ON "PropertyDevice"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "PropertyDevice_propertyId_isActive_idx" ON "PropertyDevice"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "PropertyDevice_organizationId_provider_idx" ON "PropertyDevice"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDevice_provider_externalId_key" ON "PropertyDevice"("provider", "externalId");

-- CreateIndex
CREATE INDEX "AutomationRule_organizationId_propertyId_trigger_isActive_idx" ON "AutomationRule"("organizationId", "propertyId", "trigger", "isActive");

-- CreateIndex
CREATE INDEX "DeviceAction_ruleId_idx" ON "DeviceAction"("ruleId");

-- CreateIndex
CREATE INDEX "DeviceAction_deviceId_idx" ON "DeviceAction"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_organizationId_provider_key" ON "IntegrationAccount"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "AutomationExecution_organizationId_propertyId_idx" ON "AutomationExecution"("organizationId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationExecution_reservationId_trigger_key" ON "AutomationExecution"("reservationId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyAutomationSettings_propertyId_key" ON "PropertyAutomationSettings"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyAutomationSettings_organizationId_idx" ON "PropertyAutomationSettings"("organizationId");

-- CreateIndex
CREATE INDEX "PropertyAutomationDevice_organizationId_idx" ON "PropertyAutomationDevice"("organizationId");

-- CreateIndex
CREATE INDEX "PropertyAutomationDevice_propertyId_idx" ON "PropertyAutomationDevice"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyAutomationDevice_propertyId_externalDeviceId_key" ON "PropertyAutomationDevice"("propertyId", "externalDeviceId");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_organizationId_propertyId_idx" ON "AutomationExecutionLog"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_organizationId_trigger_idx" ON "AutomationExecutionLog"("organizationId", "trigger");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_organizationId_executedAt_idx" ON "AutomationExecutionLog"("organizationId", "executedAt");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_propertyId_executedAt_idx" ON "AutomationExecutionLog"("propertyId", "executedAt");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_reservationId_idx" ON "AutomationExecutionLog"("reservationId");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_status_executedAt_idx" ON "AutomationExecutionLog"("status", "executedAt");

-- CreateIndex
CREATE INDEX "SalesFollowUp_status_dueAt_idx" ON "SalesFollowUp"("status", "dueAt");

-- CreateIndex
CREATE INDEX "SalesFollowUp_appointmentId_idx" ON "SalesFollowUp"("appointmentId");

-- CreateIndex
CREATE INDEX "PropertyAmenity_propertyId_idx" ON "PropertyAmenity"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyTax_propertyId_idx" ON "PropertyTax"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyBlockedDate_propertyId_idx" ON "PropertyBlockedDate"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyBlockedDate_propertyId_startDate_endDate_idx" ON "PropertyBlockedDate"("propertyId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "PropertyCancellationPolicy_propertyId_idx" ON "PropertyCancellationPolicy"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyCancellationPolicy_propertyId_isActive_idx" ON "PropertyCancellationPolicy"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "PropertyCancellationPolicy_type_idx" ON "PropertyCancellationPolicy"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ApmsAuditEntry_decisionId_key" ON "ApmsAuditEntry"("decisionId");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_organizationId_idx" ON "ApmsAuditEntry"("organizationId");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_propertyId_idx" ON "ApmsAuditEntry"("propertyId");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_reservationId_idx" ON "ApmsAuditEntry"("reservationId");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_entityType_entityId_idx" ON "ApmsAuditEntry"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_engine_idx" ON "ApmsAuditEntry"("engine");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_status_idx" ON "ApmsAuditEntry"("status");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_severity_idx" ON "ApmsAuditEntry"("severity");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_createdAt_idx" ON "ApmsAuditEntry"("createdAt");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_propertyId_createdAt_idx" ON "ApmsAuditEntry"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "ApmsAuditEntry_reservationId_createdAt_idx" ON "ApmsAuditEntry"("reservationId", "createdAt");

-- CreateIndex
CREATE INDEX "PropertyGuestAgreement_propertyId_isActive_idx" ON "PropertyGuestAgreement"("propertyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyGuestAgreement_propertyId_version_key" ON "PropertyGuestAgreement"("propertyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationNumberCounter_scope_key" ON "ReservationNumberCounter"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalIssue_operationalKey_key" ON "OperationalIssue"("operationalKey");

-- CreateIndex
CREATE INDEX "OperationalIssue_organizationId_idx" ON "OperationalIssue"("organizationId");

-- CreateIndex
CREATE INDEX "OperationalIssue_propertyId_idx" ON "OperationalIssue"("propertyId");

-- CreateIndex
CREATE INDEX "OperationalIssue_reservationId_idx" ON "OperationalIssue"("reservationId");

-- CreateIndex
CREATE INDEX "OperationalIssue_engine_idx" ON "OperationalIssue"("engine");

-- CreateIndex
CREATE INDEX "OperationalIssue_issueCode_idx" ON "OperationalIssue"("issueCode");

-- CreateIndex
CREATE INDEX "OperationalIssue_workflowState_idx" ON "OperationalIssue"("workflowState");

-- CreateIndex
CREATE INDEX "OperationalIssue_visibility_idx" ON "OperationalIssue"("visibility");

-- CreateIndex
CREATE INDEX "OperationalIssue_sourceAuditEntryId_idx" ON "OperationalIssue"("sourceAuditEntryId");

-- CreateIndex
CREATE INDEX "OperationalIssue_resolvedAt_idx" ON "OperationalIssue"("resolvedAt");

-- CreateIndex
CREATE INDEX "OperationalIssue_lastSignalAt_idx" ON "OperationalIssue"("lastSignalAt");

-- CreateIndex
CREATE INDEX "OperationalIssue_organizationId_visibility_workflowState_idx" ON "OperationalIssue"("organizationId", "visibility", "workflowState");

-- CreateIndex
CREATE INDEX "OperationalIssue_propertyId_visibility_workflowState_idx" ON "OperationalIssue"("propertyId", "visibility", "workflowState");

-- CreateIndex
CREATE INDEX "OperationalIssue_propertyId_lastSignalAt_idx" ON "OperationalIssue"("propertyId", "lastSignalAt");

-- CreateIndex
CREATE INDEX "OperationalIssue_reservationId_workflowState_idx" ON "OperationalIssue"("reservationId", "workflowState");

-- CreateIndex
CREATE INDEX "OperationalIssueTransition_issueId_occurredAt_idx" ON "OperationalIssueTransition"("issueId", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalIssueTransition_operationalKey_occurredAt_idx" ON "OperationalIssueTransition"("operationalKey", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalIssueTransition_toWorkflowState_occurredAt_idx" ON "OperationalIssueTransition"("toWorkflowState", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalIssueTransition_sourceAuditEntryId_idx" ON "OperationalIssueTransition"("sourceAuditEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_accessGrantId_key" ON "AccessCode"("accessGrantId");

-- CreateIndex
CREATE INDEX "AccessGrant_reservationId_method_type_idx" ON "AccessGrant"("reservationId", "method", "type");

-- CreateIndex
CREATE INDEX "AccessGrant_status_recoveryOperation_recoveryNextAttemptAt__idx" ON "AccessGrant"("status", "recoveryOperation", "recoveryNextAttemptAt", "recoveryExhaustedAt");

-- CreateIndex
CREATE INDEX "MessageLog_reservationId_idx" ON "MessageLog"("reservationId");

-- CreateIndex
CREATE INDEX "MessageLog_propertyId_idx" ON "MessageLog"("propertyId");

-- CreateIndex
CREATE INDEX "MessageLog_organizationId_idx" ON "MessageLog"("organizationId");

-- CreateIndex
CREATE INDEX "MessageLog_status_retryCount_createdAt_idx" ON "MessageLog"("status", "retryCount", "createdAt");

-- CreateIndex
CREATE INDEX "MessageLog_organizationId_propertyId_createdAt_idx" ON "MessageLog"("organizationId", "propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageLog_organizationId_status_retryCount_createdAt_idx" ON "MessageLog"("organizationId", "status", "retryCount", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeConnectAccountId_key" ON "Organization"("stripeConnectAccountId");

-- CreateIndex
CREATE INDEX "Property_organizationId_status_idx" ON "Property"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Property_organizationId_slug_key" ON "Property"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_reservationNumber_key" ON "Reservation"("reservationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_stripeCheckoutSessionId_key" ON "Reservation"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_stripeIdentityVerificationSessionId_key" ON "Reservation"("stripeIdentityVerificationSessionId");

-- CreateIndex
CREATE INDEX "Reservation_cancellationPolicyId_idx" ON "Reservation"("cancellationPolicyId");

-- CreateIndex
CREATE INDEX "Reservation_status_cancelledAt_idx" ON "Reservation"("status", "cancelledAt");

-- CreateIndex
CREATE INDEX "Reservation_propertyId_status_checkIn_idx" ON "Reservation"("propertyId", "status", "checkIn");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_propertyId_externalProvider_externalId_key" ON "Reservation"("propertyId", "externalProvider", "externalId");

COMMIT;
