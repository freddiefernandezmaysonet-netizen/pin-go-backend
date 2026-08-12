import type { ChannexBookingRevision } from "../adapters/types";

export type ChannexPersistenceAuditStatus =
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | null
  | undefined;

export type ChannexRevisionLifecycleAction =
  | "REJECT_CANCELLATION"
  | "PRESERVE_PERSISTED_SUCCESS"
  | "MARK_SUPERSEDED"
  | "INGEST";

export function parseChannexInsertedAt(value: string | null | undefined) {
  const insertedAt = new Date(String(value ?? ""));

  if (Number.isNaN(insertedAt.getTime())) {
    throw new Error("CHANNEX_REVISION_INVALID_INSERTED_AT");
  }

  return insertedAt;
}

export function isChannexCancellationRejected(args: {
  incomingStatus: ChannexBookingRevision["reservation"]["status"];
  lastIngestError: string | null | undefined;
}) {
  return (
    args.incomingStatus === "CANCELLED" &&
    args.lastIngestError === "CANCEL_REJECTED_ACTIVE_STAY"
  );
}

export function isChannexRevisionOlderOrSame(args: {
  incomingInsertedAt: Date;
  currentExternalUpdatedAt: Date | null | undefined;
}) {
  return Boolean(
    args.currentExternalUpdatedAt &&
      args.incomingInsertedAt.getTime() <=
        args.currentExternalUpdatedAt.getTime()
  );
}

export function classifyChannexRevisionLifecycle(args: {
  incomingStatus: ChannexBookingRevision["reservation"]["status"];
  incomingInsertedAt: Date;
  currentExternalUpdatedAt: Date | null | undefined;
  lastIngestError: string | null | undefined;
  existingPersistenceAuditStatus: ChannexPersistenceAuditStatus;
}): ChannexRevisionLifecycleAction {
  if (
    isChannexCancellationRejected({
      incomingStatus: args.incomingStatus,
      lastIngestError: args.lastIngestError,
    })
  ) {
    return "REJECT_CANCELLATION";
  }

  const incomingTime = args.incomingInsertedAt.getTime();
  const currentTime = args.currentExternalUpdatedAt?.getTime();

  if (currentTime !== undefined) {
    if (incomingTime < currentTime) {
      return "MARK_SUPERSEDED";
    }

    if (incomingTime === currentTime) {
      return args.existingPersistenceAuditStatus === "SUCCESS"
        ? "PRESERVE_PERSISTED_SUCCESS"
        : "INGEST";
    }
  }

  return "INGEST";
}

export function sortChannexRevisionsOldestFirst(
  revisions: ChannexBookingRevision[]
) {
  return [...revisions].sort((left, right) => {
    const leftTime = parseChannexInsertedAt(
      left.identity.insertedAt
    ).getTime();
    const rightTime = parseChannexInsertedAt(
      right.identity.insertedAt
    ).getTime();

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.identity.revisionId.localeCompare(
      right.identity.revisionId
    );
  });
}
