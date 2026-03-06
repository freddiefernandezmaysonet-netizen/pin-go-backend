export type CanonicalReservationStatus =
  | "CONFIRMED"
  | "CANCELLED"
  | "INQUIRY"
  | "HOLD";

export type CanonicalReservation = {
  provider: string;
  externalReservationId: string;
  externalListingId: string;
  listingName?: string | null;
  status: CanonicalReservationStatus;

  checkIn: string;  // ISO
  checkOut: string; // ISO
  timezone?: string;

  guest?: {
    name?: string;
    phone?: string;
    email?: string;
  };

  party?: {
    adults?: number;
    children?: number;
  };

  notes?: string;
  raw?: any; // optional normalized slice for debugging (not stored unless you want)
};

export type ParseWebhookResult = {
  eventType: string;
  externalEventId?: string | null;

  // Some providers include full reservation data; others only IDs
  reservation?: CanonicalReservation;
  externalReservationId?: string; // if only ID
};

export interface PmsAdapter {
  provider: string;

  // Validate signature if provider supports it
  verifySignature?: (args: {
    secret: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }) => boolean;

  // Parse webhook payload into canonical info or externalReservationId
  parseWebhook: (args: {
    headers: Record<string, string | string[] | undefined>;
    body: any;
  }) => ParseWebhookResult;

  // Optional: fetch full reservation by ID (API pull)
  fetchReservation?: (args: {
    connection: {
      credentialsEncrypted?: string | null;
      metadata?: any;
    };
    externalReservationId: string;
  }) => Promise<CanonicalReservation>;
}