import { useEffect, useState } from "react";
import { fetchMe } from "../../api/auth";

type StaffRow = {
  id: string;
  organizationId: string;
  fullName: string;
  phoneE164: string | null;
  companyName: string | null;
  photoUrl: string | null;
  ttlockCardRef: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        border: "1px solid #f3f4f6",
        borderRadius: 12,
        padding: 12,
        background: "#fafafa",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
        {value}
      </div>
    </div>
  );
}

export function StaffMembersPage() {
  const [organizationId, setOrganizationId] = useState("");
  const [items, setItems] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [ttlockCardRef, setTtlockCardRef] = useState("");

  async function loadStaff(orgId?: string) {
    setLoading(true);
    setErr(null);

    try {
      let resolvedOrgId = orgId ?? organizationId;

      if (!resolvedOrgId) {
        const me = await fetchMe();
        resolvedOrgId = String(me?.orgId ?? me?.organizationId ?? "");

        if (!resolvedOrgId) {
          throw new Error("No organizationId found in current session");
        }

        setOrganizationId(resolvedOrgId);
      }

      const res = await fetch(
        `${API_BASE}/staff?organizationId=${encodeURIComponent(resolvedOrgId)}`,
        {
          credentials: "include",
        }
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }

      const data: StaffRow[] = await res.json();
      setItems(data ?? []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStaff();
  }, []);

  function resetForm() {
    setFullName("");
    setPhoneE164("");
    setCompanyName("");
    setPhotoUrl("");
    setTtlockCardRef("");
    setEditingId(null);
  }

  async function handleCreateOrUpdate(e: React.FormEvent) {
    e.preventDefault();

    if (!organizationId) {
      setErr("Missing organizationId");
      return;
    }

    if (!fullName.trim()) {
      setErr("Full name is required");
      return;
    }

    setSaving(true);
    setErr(null);

    try {
      if (editingId) {
        const res = await fetch(`${API_BASE}/staff/${editingId}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fullName: fullName.trim(),
            phoneE164: phoneE164.trim() || "",
            companyName: companyName.trim() || "",
            photoUrl: photoUrl.trim() || "",
            ttlockCardRef: ttlockCardRef.trim() || "",
          }),
        });

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
      } else {
        const res = await fetch(`${API_BASE}/staff`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            organizationId,
            fullName: fullName.trim(),
            phoneE164: phoneE164.trim() || undefined,
            companyName: companyName.trim() || undefined,
            photoUrl: photoUrl.trim() || undefined,
            ttlockCardRef: ttlockCardRef.trim() || undefined,
          }),
        });

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
      }

      resetForm();
      await loadStaff(organizationId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function handleEdit(item: StaffRow) {
    setEditingId(item.id);
    setFullName(item.fullName ?? "");
    setPhoneE164(item.phoneE164 ?? "");
    setCompanyName(item.companyName ?? "");
    setPhotoUrl(item.photoUrl ?? "");
    setTtlockCardRef(item.ttlockCardRef ?? "");
    setErr(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleArchive(id: string) {
    const ok = window.confirm("Are you sure you want to archive this staff member?");
    if (!ok) return;

    setArchivingId(id);
    setErr(null);

    try {
      const res = await fetch(`${API_BASE}/staff/${id}/archive`, {
        method: "PATCH",
        credentials: "include",
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }

      if (editingId === id) {
        resetForm();
      }

      await loadStaff(organizationId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setArchivingId(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
            Staff Members
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
            Manage cleaners, technicians, and support staff for your organization.
          </div>
        </div>
      </div>

      {err ? (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            padding: 12,
            borderRadius: 12,
            color: "#991b1b",
          }}
        >
          <b>Error:</b> {err}
        </div>
      ) : null}

      <form
        onSubmit={handleCreateOrUpdate}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 16,
          background: "#fff",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>
          {editingId ? "Edit Staff Member" : "Add Staff Member"}
        </div>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
            style={{
              height: 44,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              fontSize: 14,
            }}
          />

          <input
            value={phoneE164}
            onChange={(e) => setPhoneE164(e.target.value)}
            placeholder="Phone E.164"
            style={{
              height: 44,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              fontSize: 14,
            }}
          />

          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Company name"
            style={{
              height: 44,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              fontSize: 14,
            }}
          />

          <input
            value={photoUrl}
            onChange={(e) => setPhotoUrl(e.target.value)}
            placeholder="Photo URL"
            style={{
              height: 44,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              fontSize: 14,
            }}
          />

          <input
            value={ttlockCardRef}
            onChange={(e) => setTtlockCardRef(e.target.value)}
            placeholder="TTLock card ref"
            style={{
              height: 44,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              fontSize: 14,
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              height: 44,
              padding: "0 16px",
              borderRadius: 12,
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving..." : editingId ? "Save Changes" : "Create Staff Member"}
          </button>

          {editingId ? (
            <button
              type="button"
              onClick={resetForm}
              style={{
                height: 44,
                padding: "0 16px",
                borderRadius: 12,
                border: "1px solid #d1d5db",
                background: "#fff",
                color: "#111827",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      {loading ? (
        <div style={{ color: "#666" }}>Loading...</div>
      ) : items.length === 0 ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: 16,
            color: "#666",
            background: "#fff",
          }}
        >
          No staff members found yet.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          }}
        >
          {items.map((s) => (
            <div
              key={s.id}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 18,
                padding: 18,
                background: "#fff",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                display: "grid",
                gap: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
                    {s.fullName}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Staff Member
                  </div>
                </div>

                <span
                  style={{
                    fontSize: 12,
                    padding: "4px 8px",
                    borderRadius: 999,
                    border: "1px solid #e5e7eb",
                    background: s.isActive ? "#ecfdf5" : "#fef2f2",
                    color: s.isActive ? "#065f46" : "#991b1b",
                  }}
                >
                  {s.isActive ? "ACTIVE" : "ARCHIVED"}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                }}
              >
                <Metric label="Phone" value={s.phoneE164 ?? "-"} />
                <Metric label="Company" value={s.companyName ?? "-"} />
                <Metric label="TTLock Card Ref" value={s.ttlockCardRef ?? "-"} />
                <Metric label="Photo" value={s.photoUrl ? "YES" : "NO"} />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => handleEdit(s)}
                  disabled={!s.isActive}
                  style={{
                    height: 38,
                    padding: "0 14px",
                    borderRadius: 10,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    color: "#111827",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: s.isActive ? "pointer" : "not-allowed",
                    opacity: s.isActive ? 1 : 0.6,
                  }}
                >
                  Edit
                </button>

                <button
                  type="button"
                  onClick={() => handleArchive(s.id)}
                  disabled={!s.isActive || archivingId === s.id}
                  style={{
                    height: 38,
                    padding: "0 14px",
                    borderRadius: 10,
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#b91c1c",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: !s.isActive || archivingId === s.id ? "not-allowed" : "pointer",
                    opacity: !s.isActive || archivingId === s.id ? 0.7 : 1,
                  }}
                >
                  {archivingId === s.id ? "Archiving..." : "Archive"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ color: "#666", fontSize: 13 }}>
        {loading ? "Loading..." : `${items.length} staff members`}
      </div>
    </div>
  );
}