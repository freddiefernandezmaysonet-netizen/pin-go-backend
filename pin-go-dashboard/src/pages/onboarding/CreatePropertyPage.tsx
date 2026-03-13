import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProperty } from "../../api/properties";

export default function CreatePropertyPage() {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [address1, setAddress1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");
  const [timezone, setTimezone] = useState("America/Puerto_Rico");
  const [checkInTime, setCheckInTime] = useState<"15:00" | "16:00">("15:00");
  const [cleaningStartOffsetMinutes, setCleaningStartOffsetMinutes] = useState("30");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const data = await createProperty({
        name,
        address1,
        city,
        region,
        country,
        timezone,
        checkInTime,
        cleaningStartOffsetMinutes: Number(cleaningStartOffsetMinutes),
      });

      navigate(`/properties/${data.property.id}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100%",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: 20,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.08)",
          padding: 28,
          display: "grid",
          gap: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: "#111827",
              marginBottom: 6,
            }}
          >
            Create property
          </div>

          <div
            style={{
              fontSize: 14,
              color: "#6b7280",
              lineHeight: 1.5,
            }}
          >
            Add a new property to your Pin&Go dashboard.
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Property name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Beach Villa"
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Address
            </label>
            <input
              value={address1}
              onChange={(e) => setAddress1(e.target.value)}
              placeholder="Optional"
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                City
              </label>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Optional"
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                Region
              </label>
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="Optional"
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                Country
              </label>
              <input
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="Optional"
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                Timezone
              </label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                Guest check-in time
              </label>

              <select
                value={checkInTime}
                onChange={(e) => setCheckInTime(e.target.value as "15:00" | "16:00")}
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                  background: "#fff",
                }}
              >
                <option value="15:00">3:00 PM</option>
                <option value="16:00">4:00 PM</option>
              </select>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 6,
                }}
              >
                Cleaning start offset (minutes)
              </label>

              <input
                type="number"
                min={0}
                max={180}
                value={cleaningStartOffsetMinutes}
                onChange={(e) => setCleaningStartOffsetMinutes(e.target.value)}
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  padding: "0 14px",
                  fontSize: 14,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          <div
            style={{
              borderRadius: 12,
              padding: 12,
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              color: "#4b5563",
              fontSize: 13,
            }}
          >
            {checkInTime === "15:00"
              ? "Check-in at 3:00 PM sets cleaning duration to 180 minutes."
              : "Check-in at 4:00 PM sets cleaning duration to 240 minutes."}
          </div>

          {error ? (
            <div
              style={{
                borderRadius: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: 13,
                padding: "10px 12px",
              }}
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            style={{
              height: 46,
              borderRadius: 12,
              border: "none",
              background: submitting ? "#93c5fd" : "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              cursor: submitting ? "not-allowed" : "pointer",
              marginTop: 4,
            }}
          >
            {submitting ? "Creating..." : "Create Property"}
          </button>
        </form>
      </div>
    </div>
  );
}