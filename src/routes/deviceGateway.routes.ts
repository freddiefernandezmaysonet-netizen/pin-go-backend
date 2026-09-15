import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

/**
 * Legacy gateway refresh endpoint retired.
 *
 * Gateway monitoring configuration and verification now flow through the
 * authenticated dashboard locks route and the hardened DeviceHealth worker.
 * Keeping this builder as an empty router avoids reintroducing the legacy
 * unauthenticated mutation surface while preserving the current server import
 * boundary until the surrounding router registration is cleaned up separately.
 */
export default function buildDeviceGatewayRouter(_prisma: PrismaClient) {
  return Router();
}
