import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type LocksCapacityResp = {
  ok: boolean;
  error?: string;
  entitledLocks: number;
  usedLocks: number;
  remainingLocks: number;
  utilizationPct: number;
  status?: string | null;
};

function cardStyle(): React.CSSProperties {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 18,
    background: "#fff",
    display: "grid",
    gap: 14,
  };
}

function labelStyle(): React.CSSProperties {
  return {
    fontSize: 13,
    color: "#6b7280",
  };
}

function valueStyle(): React.CSSProperties {
  return {
    fontSize: 28,
    fontWeight: 700,
    color: "#111827",
    lineHeight: 1.1,
  };
}

function progressOuterStyle(): React.CSSProperties {
  return {
    width: "100%",
    height: 12,
    borderRadius: 999,
    background: "#e5e7eb",
    overflow: "hidden",
  };
}

function getProgressInnerStyle(
  utilizationPct: number,
  entitledLocks: number,
  usedLocks: number
): React.CSSProperties {
  const safePct = Math.max(0, Math.min(utilizationPct, 100));

  const isCritical = usedLocks > entitledLocks;
  const isSmallAccountAtFullCapacity =
    usedLocks === entitledLocks && usedLocks <= 2;
  const shouldShowCapacityAlertColors =
    entitledLocks >= 3 || usedLocks >= 3;

  let background = "#111827";

  if (isCritical) {
    background = "#dc2626";
  } else if (isSmallAccountAtFullCapacity) {
    background = "#111827";
  } else if (shouldShowCapacityAlertColors) {
    background =
      safePct >= 100
        ? "#ea580c"
        : safePct >= 90
        ? "#d97706"
        : safePct >= 75
        ? "#f59e0b"
        : "#111827";
  }

  return {
    width: `${safePct}%`,
    height: "100%",
    borderRadius: 999,
    background,
    transition: "width 200ms ease",
  };
}

function getStatusMessage(
  remainingLocks: number,
  entitledLocks: number,
  usedLocks: number
) {
  if (entitledLocks <= 0) {
    return {
      text: "No locks included in current plan.",
      tone: "#991b1b",
      bg: "#fef2f2",
      border: "#fecaca",
    };
  }

  if (usedLocks > entitledLocks) {
    return {
      text: "System inconsistency: active locks exceed plan capacity.",
      tone: "#991b1b",
      bg: "#fef2f2",
      border: "#fecaca",
    };
  }

  if (usedLocks === entitledLocks && usedLocks <= 2) {
    return {
      text: "Your current lock capacity is fully allocated and aligned with your setup.",
      tone: "#374151",
      bg: "#f9fafb",
      border: "#e5e7eb",
    };
  }

  if (remainingLocks <= 0) {
    return {
      text: "You are at full capacity. Add more only if you plan to activate another lock.",
      tone: "#92400e",
      bg: "#fffbeb",
      border: "#fcd34d",
    };
  }

  if (remainingLocks === 1) {
    return {
      text: "Only 1 lock remaining before reaching your current plan capacity.",
      tone: "#9a3412",
      bg: "#fff7ed",
      border: "#fdba74",
    };
  }

  if (remainingLocks === 2) {
    return {
      text: "You have 2 locks remaining in your current plan.",
      tone: "#92400e",
      bg: "#fffbeb",
      border: "#fcd34d",
    };
  }

  return {
    text: `${remainingLocks} locks remaining in your current plan.`,
    tone: "#166534",
    bg: "#f0fdf4",
    border: "#bbf7d0",
  };
}

export function LocksCapacityCard() {
  const [data, setData] = useState<LocksCapacityResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadCapacity() {
    setLoading(true);
    setError(null);

    try {
      const r = await fetch(`${API_BASE}/api/dashboard/locks/capacity`, {
        credentials: "include",
      });

      const json: LocksCapacityResp = await r.json();

      if (!r.ok || !json.ok) {
        setData(null);
        setError(json.error ?? "Unable to load locks capacity.");
        return;
      }

      setData(json);
    } catch (e: any) {
      setData(null);
      setError(String(e?.message ?? e ?? "Unable to load locks capacity."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCapacity();
  }, []);

  const statusBox = useMemo(() => {
    if (!data) return null;
    return getStatusMessage(
      data.remainingLocks,
      data.entitledLocks,
      data.usedLocks
    );
  }, [data]);

  if (loading) {
    return (
      <div style={cardStyle()}>
        <div style={labelStyle()}>Locks Capacity</div>
        <div style={{ color: "#6b7280" }}>Loading capacity...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={cardStyle()}>
        <div style={labelStyle()}>Locks Capacity</div>
        <div
          style={{
            borderRadius: 12,
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: 14,
          }}
        >
          {error ?? "Unable to load locks capacity."}
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle()}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={labelStyle()}>Locks Capacity</div>
          <div style={valueStyle()}>
            {data.usedLocks} / {data.entitledLocks}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={labelStyle()}>Remaining</div>
          <div style={valueStyle()}>{data.remainingLocks}</div>
        </div>
      </div>

      <div style={progressOuterStyle()}>
        <div
          style={getProgressInnerStyle(
            data.utilizationPct,
            data.entitledLocks,
            data.usedLocks
          )}
        />
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        }}
      >
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fafafa",
          }}
        >
          <div style={labelStyle()}>Included</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {data.entitledLocks}
          </div>
        </div>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fafafa",
          }}
        >
          <div style={labelStyle()}>Active</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.usedLocks}</div>
        </div>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fafafa",
          }}
        >
          <div style={labelStyle()}>Usage</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {data.utilizationPct}%
          </div>
        </div>
      </div>

      {statusBox ? (
        <div
          style={{
            borderRadius: 12,
            padding: 12,
            background: statusBox.bg,
            border: `1px solid ${statusBox.border}`,
            color: statusBox.tone,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {statusBox.text}
        </div>
      ) : null}
    </div>
  );
}