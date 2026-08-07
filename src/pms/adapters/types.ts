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

  checkIn: string; // ISO
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

export type ChannexBookingWebhookEventType =
  | "booking"
  | "booking_new"
  | "booking_modification"
  | "booking_cancellation"
  | "non_acked_booking";

export type ChannexBookingRevisionIdentity = {
  revisionId: string;
  bookingId: string;
  bookingUniqueId?: string | null;
  otaReservationCode?: string | null;
  propertyId: string;
  liveFeedEventId?: string | null;
  systemId?: string | null;
  insertedAt?: string | null;
};

export type ChannexBookingRevision = {
  identity: ChannexBookingRevisionIdentity;
  reservation: CanonicalReservation;
  raw: any;
};

export type ParseWebhookResult = {
  eventType: string;
  externalEventId?: string | null;

  // Some providers include full reservation data; others only IDs.
  reservation?: CanonicalReservation;
  externalReservationId?: string;

  // Channex booking lifecycle signal. A webhook can provide a concrete
  // revision ID or only a property ID, in which case the Feed is the recovery
  // source. Booking, revision and source-message identifiers stay separate.
  bookingRevision?: Partial<ChannexBookingRevisionIdentity> & {
    propertyId: string;
  };
};

export type PmsAdapterConnection = {
  id?: string;
  credentialsEncrypted?: string | null;
  metadata?: any;
};

export interface PmsAdapter {
  provider: string;

  // Validate signature if provider supports it.
  verifySignature?: (args: {
    secret: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }) => boolean;

  // Parse webhook payload into canonical info or provider-specific identity.
  parseWebhook: (args: {
    headers: Record<string, string | string[] | undefined>;
    body: any;
  }) => ParseWebhookResult;

  // Optional: fetch full reservation by stable provider reservation ID.
  fetchReservation?: (args: {
    connection: PmsAdapterConnection;
    externalReservationId: string;
  }) => Promise<CanonicalReservation>;

  // Channex-specific booking revision lifecycle operations. Other adapters do
  // not need to implement these optional methods.
  fetchBookingRevision?: (args: {
    connection: PmsAdapterConnection;
    revisionId: string;
  }) => Promise<ChannexBookingRevision>;

  fetchBookingRevisionFeed?: (args: {
    connection: PmsAdapterConnection;
  }) => Promise<ChannexBookingRevision[]>;

  acknowledgeBookingRevision?: (args: {
    connection: PmsAdapterConnection;
    revisionId: string;
  }) => Promise<void>;
}
