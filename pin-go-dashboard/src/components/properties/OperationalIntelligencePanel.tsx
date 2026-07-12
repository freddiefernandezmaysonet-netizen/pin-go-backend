import type { CSSProperties } from "react";

export type OperationalWorkflowState =
  | "ACTION_REQUIRED"
  | "WAITING"
  | "AUTO_RESOLVING"
  | "RESOLVED";

export type OperationalIntelligenceItem = {
  issueCode: string;
  title: string;
  issue: string;
  operationalImpact?: string | null;
  recommendedAction?: string | null;
  nextAutomaticStep?: string | null;
  engine: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  workflowState: OperationalWorkflowState;
  visibility: "HOST";
  responsibleActor: string;
  actionRequired: boolean;
  canAutoResolve: boolean;
  autoResolveStatus:
    | "AVAILABLE"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "NOT_SUPPORTED";
  reservationId?: string | null;
  reservationNumber?: string | null;
  guestName?: string | null;
  cleanerName?: string | null;
  firstDetectedAt: string | Date;
  lastSignalAt: string | Date;
  resolvedAt?: string | Date | null;
  resolutionCode?: string | null;
  resolutionSummary?: string | null;
  resolutionType?:
    | "AUTOMATIC"
    | "MANUAL"
    | "EXPIRED"
    | "SUPERSEDED"
    | null;
  resolvedBy?: string | null;
  actionTarget: string;
  openUrl?: string | null;
  secondaryActionUrl?: string | null;
};

type OperationalIntelligencePanelProps = {
  items: OperationalIntelligenceItem[];
  onOpenReservation?: (reservationId: string) => void;
};

type StatePresentation = {
  label: string;
  summaryLabel: string;
  color: string;
  background: string;
  border: string;
};

const statePresentation: Record<OperationalWorkflowState, StatePresentation> = {
  ACTION_REQUIRED: {
    label: "Needs attention",
    summaryLabel: "Attention",
    color: "#b91c1c",
    background: "#fff7f7",
    border: "#fecaca",
  },
  WAITING: {
    label: "Waiting",
    summaryLabel: "Waiting",
    color: "#1d4ed8",
    background: "#f8fbff",
    border: "#bfdbfe",
  },
  AUTO_RESOLVING: {
    label: "Pin&Go working",
    summaryLabel: "Working",
    color: "#6d28d9",
    background: "#faf8ff",
    border: "#ddd6fe",
  },
  RESOLVED: {
    label: "Resolved",
    summaryLabel: "Resolved",
    color: "#047857",
    background: "#f7fdf9",
    border: "#bbf7d0",
  },
};

const stateOrder: OperationalWorkflowState[] = [
  "ACTION_REQUIRED",
  "AUTO_RESOLVING",
  "WAITING",
  "RESOLVED",
];

function getTimestamp(item: OperationalIntelligenceItem) {
  const rawValue =
    item.workflowState === "RESOLVED"
      ? item.resolvedAt ?? item.lastSignalAt
      : item.lastSignalAt;
  const date = rawValue ? new Date(rawValue) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function formatTimestamp(item: OperationalIntelligenceItem) {
  const timestamp = getTimestamp(item);
  if (!timestamp) return "Live signal";

  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatActor(value: unknown) {
  const actor = String(value ?? "").trim().toUpperCase();
  if (actor === "PIN_GO") return "Pin&Go";
  if (actor === "PIN_AI") return "Pin AI";
  if (actor === "HOST") return "Host";
  if (actor === "GUEST") return "Guest";
  if (actor === "CLEANER") return "Cleaner";
  if (actor === "STAFF") return "Staff";
  if (actor === "SYSTEM") return "System";
  return "None";
}

function getPrimaryDetail(item: OperationalIntelligenceItem) {
  if (item.workflowState === "ACTION_REQUIRED") {
    return item.recommendedAction ?? item.operationalImpact ?? item.issue;
  }
  if (item.workflowState === "WAITING" || item.workflowState === "AUTO_RESOLVING") {
    return item.nextAutomaticStep ?? item.issue;
  }
  return item.resolutionSummary ?? item.issue;
}

function OperationalRow({
  item,
  onOpenReservation,
}: {
  item: OperationalIntelligenceItem;
  onOpenReservation?: (reservationId: string) => void;
}) {
  const presentation = statePresentation[item.workflowState];
  const reservationNumber = String(item.reservationNumber ?? "").trim();
  const canOpenReservation = Boolean(item.reservationId && onOpenReservation);

  return (
    <article
      style={{
        ...styles.row,
        borderLeftColor: presentation.color,
        background: presentation.background,
      }}
    >
      <div style={styles.rowMain}>
        <div style={styles.rowHeading}>
          <div style={styles.identity}>
            <span
              style={{
                ...styles.stateDot,
                background: presentation.color,
              }}
            />
            <div>
              <div style={styles.metaLine}>
                <span>{item.engine} Engine</span>
                {reservationNumber ? (
                  <>
                    <span aria-hidden="true">•</span>
                    <span style={styles.reservationNumber}>#{reservationNumber}</span>
                  </>
                ) : null}
                {item.guestName ? (
                  <>
                    <span aria-hidden="true">•</span>
                    <span>{item.guestName}</span>
                  </>
                ) : null}
              </div>
              <h4 style={styles.rowTitle}>{item.title}</h4>
            </div>
          </div>

          <span
            style={{
              ...styles.stateBadge,
              color: presentation.color,
              borderColor: presentation.border,
            }}
          >
            {presentation.label}
          </span>
        </div>

        <p style={styles.issueText}>{item.issue}</p>
        <div style={styles.nextStep}>
          <strong>
            {item.workflowState === "ACTION_REQUIRED"
              ? "Next action: "
              : item.workflowState === "RESOLVED"
                ? "Outcome: "
                : "Next step: "}
          </strong>
          {getPrimaryDetail(item)}
        </div>

        <div style={styles.footer}>
          <span>Responsible: {formatActor(item.responsibleActor)}</span>
          <span aria-hidden="true">•</span>
          <span>{formatTimestamp(item)}</span>
        </div>
      </div>

      {canOpenReservation ? (
        <button
          type="button"
          onClick={() => onOpenReservation?.(String(item.reservationId))}
          style={styles.openButton}
        >
          Open Reservation
        </button>
      ) : null}
    </article>
  );
}

export function OperationalIntelligencePanel({
  items,
  onOpenReservation,
}: OperationalIntelligencePanelProps) {
  const hostItems = Array.isArray(items)
    ? items.filter((item) => item.visibility === "HOST")
    : [];

  if (hostItems.length === 0) return null;

  const sortedItems = [...hostItems].sort((left, right) => {
    const stateDifference =
      stateOrder.indexOf(left.workflowState) -
      stateOrder.indexOf(right.workflowState);
    return stateDifference || getTimestamp(right) - getTimestamp(left);
  });

  const counts = stateOrder.map((state) => ({
    state,
    count: hostItems.filter((item) => item.workflowState === state).length,
  }));

  const needsAttention = counts.find(
    (item) => item.state === "ACTION_REQUIRED"
  )?.count;

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>OPERATIONAL INTELLIGENCE</div>
          <h3 style={styles.title}>Current Operational State</h3>
          <p style={styles.description}>
            What needs attention, what Pin&Go is handling and what was resolved.
          </p>
        </div>

        <div style={styles.summary}>
          {counts.map(({ state, count }) => {
            const presentation = statePresentation[state];
            return (
              <div key={state} style={styles.summaryItem}>
                <span style={{ color: presentation.color }}>{count}</span>
                <small>{presentation.summaryLabel}</small>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          ...styles.overallStatus,
          color: needsAttention ? "#991b1b" : "#065f46",
          background: needsAttention ? "#fef2f2" : "#ecfdf5",
        }}
      >
        {needsAttention
          ? `${needsAttention} issue${needsAttention === 1 ? "" : "s"} require host attention.`
          : "No host action is required right now."}
      </div>

      <div style={styles.list}>
        {sortedItems.map((item, index) => (
          <OperationalRow
            key={`${item.issueCode}-${item.reservationNumber ?? "property"}-${index}`}
            item={item}
            onOpenReservation={onOpenReservation}
          />
        ))}
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    overflow: "hidden",
    border: "1px solid #dbe4ee",
    borderRadius: 14,
    background: "#ffffff",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    padding: "16px 18px",
    borderBottom: "1px solid #e2e8f0",
    background: "#0f172a",
    flexWrap: "wrap",
  },
  eyebrow: {
    marginBottom: 3,
    color: "#93c5fd",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: "0.12em",
  },
  title: {
    margin: 0,
    color: "#ffffff",
    fontSize: 18,
    lineHeight: 1.25,
  },
  description: {
    margin: "4px 0 0",
    color: "#cbd5e1",
    fontSize: 12,
  },
  summary: {
    display: "flex",
    alignItems: "stretch",
    gap: 6,
    flexWrap: "wrap",
  },
  summaryItem: {
    display: "grid",
    minWidth: 66,
    padding: "6px 9px",
    border: "1px solid #334155",
    borderRadius: 8,
    background: "#111c30",
    textAlign: "center",
  },
  overallStatus: {
    padding: "8px 18px",
    fontSize: 12,
    fontWeight: 800,
    borderBottom: "1px solid #e2e8f0",
  },
  list: {
    display: "grid",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    padding: "14px 16px",
    borderBottom: "1px solid #e2e8f0",
    borderLeft: "4px solid",
  },
  rowMain: {
    minWidth: 0,
    flex: 1,
  },
  rowHeading: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  identity: {
    display: "flex",
    alignItems: "flex-start",
    gap: 9,
  },
  stateDot: {
    flex: "0 0 auto",
    width: 8,
    height: 8,
    marginTop: 5,
    borderRadius: 999,
  },
  metaLine: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    color: "#64748b",
    fontSize: 10,
    fontWeight: 800,
  },
  reservationNumber: {
    color: "#1d4ed8",
  },
  rowTitle: {
    margin: "3px 0 0",
    color: "#0f172a",
    fontSize: 14,
    lineHeight: 1.3,
  },
  stateBadge: {
    flex: "0 0 auto",
    padding: "4px 8px",
    border: "1px solid",
    borderRadius: 999,
    background: "#ffffff",
    fontSize: 10,
    fontWeight: 900,
  },
  issueText: {
    margin: "7px 0 0 17px",
    color: "#334155",
    fontSize: 12,
    lineHeight: 1.45,
  },
  nextStep: {
    margin: "4px 0 0 17px",
    color: "#475569",
    fontSize: 11,
    lineHeight: 1.45,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: "7px 0 0 17px",
    color: "#64748b",
    fontSize: 10,
  },
  openButton: {
    flex: "0 0 auto",
    minHeight: 32,
    padding: "0 11px",
    border: "1px solid #bfdbfe",
    borderRadius: 8,
    background: "#eff6ff",
    color: "#1d4ed8",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
};