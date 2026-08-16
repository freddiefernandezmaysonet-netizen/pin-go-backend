import { Router, type Request, type Response } from "express";
import {
  acceptOrganizationOwnerInvitation,
  inspectOrganizationOwnerInvitation,
  OrganizationInvitationError,
} from "../services/branding/organization-invitation.service.js";

class PublicOrganizationInvitationInputError extends Error {
  constructor(readonly field: string) {
    super(`${field} must be a string.`);
    this.name = "PublicOrganizationInvitationInputError";
  }
}

export const publicOrganizationInvitationRouter = Router();

publicOrganizationInvitationRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

function bodyString(req: Request, field: string): string {
  const value = req.body?.[field];
  if (typeof value !== "string") {
    throw new PublicOrganizationInvitationInputError(field);
  }
  return value;
}

function sendInvitationError(
  res: Response,
  error: unknown,
  unexpectedErrorCode = "ORGANIZATION_INVITATION_ACCEPTANCE_FAILED"
): void {
  if (error instanceof PublicOrganizationInvitationInputError) {
    res.status(400).json({
      ok: false,
      error: "ORGANIZATION_INVITATION_INPUT_INVALID",
      field: error.field,
      message: error.message,
    });
    return;
  }

  if (error instanceof OrganizationInvitationError) {
    if (error.code === "ORGANIZATION_INVITATION_PASSWORD_WEAK") {
      const details = Array.isArray(error.context.errors)
        ? error.context.errors
        : [];
      res.status(400).json({
        ok: false,
        error: error.code,
        details,
      });
      return;
    }

    if (error.code === "ORGANIZATION_INVITATION_EMAIL_REGISTERED") {
      res.status(409).json({
        ok: false,
        error: error.code,
      });
      return;
    }

    res.status(400).json({
      ok: false,
      error: "INVALID_OR_EXPIRED_ORGANIZATION_INVITATION",
    });
    return;
  }

  console.error("[PUBLIC_ORGANIZATION_INVITATION_ROUTE_ERROR]", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({
    ok: false,
    error: unexpectedErrorCode,
  });
}

publicOrganizationInvitationRouter.post(
  "/api/public/organization-invitations/inspect",
  async (req, res) => {
    try {
      const invitation = await inspectOrganizationOwnerInvitation({
        token: bodyString(req, "token"),
      });

      res.json({ ok: true, data: invitation });
    } catch (error) {
      sendInvitationError(
        res,
        error,
        "ORGANIZATION_INVITATION_INSPECTION_FAILED"
      );
    }
  }
);

publicOrganizationInvitationRouter.post(
  "/api/public/organization-invitations/accept",
  async (req, res) => {
    try {
      const result = await acceptOrganizationOwnerInvitation({
        token: bodyString(req, "token"),
        fullName: bodyString(req, "fullName"),
        password: bodyString(req, "password"),
      });

      res.status(201).json({
        ok: true,
        data: {
          user: result.user,
          organizationId: result.invitation.organizationId,
          acceptedAt: result.invitation.acceptedAt,
        },
      });
    } catch (error) {
      sendInvitationError(res, error);
    }
  }
);
