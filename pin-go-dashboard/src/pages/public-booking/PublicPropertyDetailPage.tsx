import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

type PublicProperty = {
  id: string;
  organizationId: string;
  name: string;
  slug: string | null;
  publicTitle?: string | null;
  publicDescription?: string | null;
  publicPhotos?: unknown;
  baseNightlyRate?: string | number | null;
  cleaningFee?: string | number | null;
  maxGuests?: number | null;
  minimumNights?: number | null;
  maximumNights?: number | null;
  address1?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  timezone?: string | null;
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE ||
  "https://api.pin-ngo.com";

function getPhotoUrls(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function formatMoney(value: string | number | null | undefined) {
  const n = Number(value ?? 0);

  if (!Number.isFinite(n) || n <= 0) return "$0";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function diffNights(checkIn: string, checkOut: string) {
  if (!checkIn || !checkOut) return 0;

  const start = new Date(`${checkIn}T00:00:00`);
  const end = new Date(`${checkOut}T00:00:00`);

  const nights = Math.ceil(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );

  return Number.isFinite(nights) && nights > 0 ? nights : 0;
}

export default function PublicPropertyDetailPage() {
  const { organizationSlug, propertySlug } = useParams();

  const [property, setProperty] = useState<PublicProperty | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [availabilityStatus, setAvailabilityStatus] = useState<
    "idle" | "available" | "unavailable"
  >("idle");
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(
    null
  );

const [adults, setAdults] = useState(1);
const [children, setChildren] = useState(0);

  const photos = useMemo(() => getPhotoUrls(property?.publicPhotos), [property]);
  const nights = useMemo(() => diffNights(checkIn, checkOut), [checkIn, checkOut]);

  const nightlyRate = Number(property?.baseNightlyRate ?? 0);
  const cleaningFee = Number(property?.cleaningFee ?? 0);
  const subtotal = nights * nightlyRate;
  const total = subtotal + cleaningFee;

  const location = [
    property?.address1,
    property?.city,
    property?.region,
    property?.country,
  ]
    .filter(Boolean)
    .join(", ");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        setPageError(null);

        const res = await fetch(
          `${API_BASE}/api/public-booking/${organizationSlug}/${propertySlug}`
        );

        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Property not found");
        }

        if (active) {
          setProperty(data.property);
        }
      } catch (err: any) {
        if (active) {
          setPageError(err?.message || "Failed to load property");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (organizationSlug && propertySlug) {
      load();
    }

    return () => {
      active = false;
    };
  }, [organizationSlug, propertySlug]);

  useEffect(() => {
    setAvailabilityStatus("idle");
    setAvailabilityMessage(null);
  }, [checkIn, checkOut]);

  async function handleCheckAvailability() {
    try {
      setCheckingAvailability(true);
      setAvailabilityStatus("idle");
      setAvailabilityMessage(null);
      setBookingError(null);

      if (!property) {
        throw new Error("Property not loaded");
      }

      if (!checkIn || !checkOut) {
        throw new Error("Please select check-in and check-out dates.");
      }

      if (nights <= 0) {
        throw new Error("Check-out must be after check-in.");
      }

      if (nights < (property.minimumNights ?? 1)) {
        throw new Error(
          `Minimum stay is ${property.minimumNights ?? 1} night(s).`
        );
      }

      if (property.maximumNights && nights > property.maximumNights) {
        throw new Error(`Maximum stay is ${property.maximumNights} night(s).`);
      }

const totalGuests = adults + children;

if (totalGuests < 1) {
  throw new Error("Please select at least one guest.");
}

if (property.maxGuests && totalGuests > property.maxGuests) {
  throw new Error(`Maximum guests allowed is ${property.maxGuests}.`);
}

      const res = await fetch(`${API_BASE}/api/public-booking/check-availability`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          propertyId: property.id,
          checkIn,
          checkOut,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Unable to check availability.");
      }

      if (data.available) {
        setAvailabilityStatus("available");
        setAvailabilityMessage("Available for the selected dates.");
        return;
      }

      setAvailabilityStatus("unavailable");
      setAvailabilityMessage(
        "This property is not available for the selected dates."
      );
    } catch (err: any) {
      setAvailabilityStatus("unavailable");
      setAvailabilityMessage(err?.message || "Unable to check availability.");
    } finally {
      setCheckingAvailability(false);
    }
  }

  async function handleReserve(e: React.FormEvent) {
    e.preventDefault();

    try {
      setSubmitting(true);
      setBookingError(null);

      if (!property) {
        throw new Error("Property not loaded");
      }

      if (availabilityStatus !== "available") {
        throw new Error("Please check availability before reserving.");
      }

      if (!checkIn || !checkOut || !guestName.trim() || !guestEmail.trim()) {
        throw new Error("Please complete check-in, check-out, name and email.");
      }

      if (nights <= 0) {
        throw new Error("Check-out must be after check-in.");
      }

      if (nights < (property.minimumNights ?? 1)) {
        throw new Error(
          `Minimum stay is ${property.minimumNights ?? 1} night(s).`
        );
      }

      if (property.maximumNights && nights > property.maximumNights) {
        throw new Error(`Maximum stay is ${property.maximumNights} night(s).`);
      }

      const res = await fetch(`${API_BASE}/api/public-booking/create-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          propertyId: property.id,
          checkIn,
          checkOut,
          guestName: guestName.trim(),
          adults,
          children,
          guestEmail: guestEmail.trim(),
          guestPhone: guestPhone.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok || !data.checkoutUrl) {
        throw new Error(data.error || "Unable to create checkout.");
      }

      window.location.href = data.checkoutUrl;
    } catch (err: any) {
      setBookingError(err?.message || "Unable to reserve this property.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <Link to={`/book/${organizationSlug}`} style={styles.brandWrap}>
            <img
              src="/pin-go-logo.png"
              alt="Pin&Go logo"
              style={styles.logo}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <div>
              <div style={styles.brandName}>Pin&Go</div>
              <div style={styles.slogan}>Direct Booking</div>
            </div>
          </Link>
        </div>
      </header>

      <main>
        {loading ? (
          <section style={styles.heroSection}>
            <div style={styles.heroContainer}>
              <h1 style={styles.heroTitle}>Loading property...</h1>
            </div>
          </section>
        ) : pageError || !property ? (
          <section style={styles.sectionAlt}>
            <div style={styles.container}>
              <div style={styles.errorBox}>{pageError || "Property not found"}</div>
            </div>
          </section>
        ) : (
          <>
            <section style={styles.heroSection}>
              <div style={styles.heroContainer}>
                <div style={styles.badge}>{property.organization.name}</div>
                <h1 style={styles.heroTitle}>
                  {property.publicTitle || property.name}
                </h1>
                <p style={styles.heroSubtitle}>
                  {property.publicDescription ||
                    "Book this property directly through Pin&Go."}
                </p>
              </div>
            </section>

            <section style={styles.sectionAlt}>
              <div style={styles.container}>
                <div style={styles.gallery}>
                  {photos.length > 0 ? (
                    photos.slice(0, 4).map((photo) => (
                      <img
                        key={photo}
                        src={photo}
                        alt={property.publicTitle || property.name}
                        style={styles.galleryImage}
                      />
                    ))
                  ) : (
                    <div style={styles.photoPlaceholder}>Pin&Go Stay</div>
                  )}
                </div>

                <div style={styles.detailGrid}>
                  <div style={styles.infoCard}>
                    <h2 style={styles.sectionTitle}>Property details</h2>

                    <div style={styles.infoList}>
                      {location ? (
                        <div style={styles.infoItem}>
                          <strong>Location</strong>
                          <span>{location}</span>
                        </div>
                      ) : null}

                      <div style={styles.infoItem}>
                        <strong>Check-in</strong>
                        <span>{property.checkInTime || "Configured by host"}</span>
                      </div>

                      <div style={styles.infoItem}>
                        <strong>Check-out</strong>
                        <span>{property.checkOutTime || "11:00"}</span>
                      </div>

                      {property.maxGuests ? (
                        <div style={styles.infoItem}>
                          <strong>Guests</strong>
                          <span>Up to {property.maxGuests}</span>
                        </div>
                      ) : null}

                      <div style={styles.infoItem}>
                        <strong>Minimum stay</strong>
                        <span>{property.minimumNights ?? 1} night(s)</span>
                      </div>

                      {property.maximumNights ? (
                        <div style={styles.infoItem}>
                          <strong>Maximum stay</strong>
                          <span>{property.maximumNights} night(s)</span>
                        </div>
                      ) : null}

                      <div style={styles.infoItem}>
                        <strong>Nightly rate</strong>
                        <span>{formatMoney(property.baseNightlyRate)}</span>
                      </div>

                      <div style={styles.infoItem}>
                        <strong>Cleaning fee</strong>
                        <span>{formatMoney(property.cleaningFee)}</span>
                      </div>
                    </div>
                  </div>

                  <form onSubmit={handleReserve} style={styles.bookingCard}>
                    <h2 style={styles.bookingTitle}>Reserve your stay</h2>

                    <label style={styles.field}>
                      <span>Check-in</span>
                      <input
                        type="date"
                        value={checkIn}
                        onChange={(e) => setCheckIn(e.target.value)}
                        style={styles.input}
                      />
                    </label>

                    <label style={styles.field}>
                      <span>Check-out</span>
                      <input
                        type="date"
                        value={checkOut}
                        onChange={(e) => setCheckOut(e.target.value)}
                        style={styles.input}
                      />
                    </label>

<label style={styles.field}>
  <span>Adults</span>
  <input
    type="number"
    min={1}
    value={adults}
    onChange={(e) => setAdults(Number(e.target.value))}
    style={styles.input}
  />
</label>

<label style={styles.field}>
  <span>Children</span>
  <input
    type="number"
    min={0}
    value={children}
    onChange={(e) => setChildren(Number(e.target.value))}
    style={styles.input}
  />
</label>

                    <button
                      type="button"
                      onClick={handleCheckAvailability}
                      disabled={checkingAvailability || !checkIn || !checkOut}
                      style={{
                        ...styles.secondaryButton,
                        ...(checkingAvailability || !checkIn || !checkOut
                          ? styles.secondaryButtonDisabled
                          : {}),
                      }}
                    >
                      {checkingAvailability ? "Checking..." : "Check availability"}
                    </button>

                    {availabilityMessage ? (
                      <div
                        style={{
                          ...styles.availabilityBox,
                          ...(availabilityStatus === "available"
                            ? styles.availabilityBoxSuccess
                            : styles.availabilityBoxError),
                        }}
                      >
                        {availabilityStatus === "available" ? "✅ " : "⚠️ "}
                        {availabilityMessage}
                      </div>
                    ) : null}

                    <label style={styles.field}>
                      <span>Full name</span>
                      <input
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        placeholder="Guest name"
                        style={styles.input}
                      />
                    </label>

                    <label style={styles.field}>
                      <span>Email</span>
                      <input
                        type="email"
                        value={guestEmail}
                        onChange={(e) => setGuestEmail(e.target.value)}
                        placeholder="guest@email.com"
                        style={styles.input}
                      />
                    </label>

                    <label style={styles.field}>
                      <span>Phone</span>
                      <input
                        value={guestPhone}
                        onChange={(e) => setGuestPhone(e.target.value)}
                        placeholder="+1..."
                        style={styles.input}
                      />
                    </label>

                    <div style={styles.priceBox}>
                     <div style={styles.priceRow}>
  <span>Guests</span>
  <strong>{adults + children}</strong>
</div> 
                     <div style={styles.priceRow}>
                        <span>
                          {formatMoney(property.baseNightlyRate)} × {nights || 0}{" "}
                          nights
                        </span>
                        <strong>{formatMoney(subtotal)}</strong>
                      </div>

                      <div style={styles.priceRow}>
                        <span>Cleaning fee</span>
                        <strong>{formatMoney(cleaningFee)}</strong>
                      </div>

                      <div style={styles.totalRow}>
                        <span>Total</span>
                        <strong>{formatMoney(total)}</strong>
                      </div>
                    </div>

                    {bookingError ? (
                      <div style={styles.inlineError}>{bookingError}</div>
                    ) : null}

                    <button
                      type="submit"
                      disabled={submitting || availabilityStatus !== "available"}
                      style={{
                        ...styles.reserveButton,
                        ...(submitting || availabilityStatus !== "available"
                          ? styles.reserveButtonDisabled
                          : {}),
                      }}
                    >
                      {submitting ? "Preparing checkout..." : "Reserve now"}
                    </button>

                    <p style={styles.disclaimer}>
                      You will be redirected to Stripe Checkout to complete your
                      payment.
                    </p>
                  </form>
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      <footer style={styles.footer}>
        <div style={styles.container}>
          © Pin&Go. Direct booking powered by autonomous property operations.
        </div>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: "#0f172a",
    backgroundColor: "#ffffff",
    minHeight: "100vh",
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 20,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid #e2e8f0",
  },
  headerInner: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "14px 20px",
  },
  brandWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    textDecoration: "none",
    color: "#0f172a",
  },
  logo: {
    width: 48,
    height: 48,
    objectFit: "contain",
    borderRadius: 10,
  },
  brandName: {
    fontSize: 22,
    fontWeight: 800,
    lineHeight: 1.1,
  },
  slogan: {
    fontSize: 13,
    color: "#64748b",
    marginTop: 2,
  },
  heroSection: {
    padding: "70px 20px 58px",
    background:
      "radial-gradient(circle at top, rgba(59,130,246,0.08), transparent 35%), linear-gradient(to bottom, #ffffff, #f8fafc)",
  },
  heroContainer: {
    maxWidth: 900,
    margin: "0 auto",
    textAlign: "center",
  },
  badge: {
    display: "inline-block",
    background: "#e2e8f0",
    color: "#0f172a",
    padding: "8px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 20,
  },
  heroTitle: {
    fontSize: "clamp(2rem, 5vw, 3.4rem)",
    lineHeight: 1.05,
    fontWeight: 800,
    margin: 0,
  },
  heroSubtitle: {
    maxWidth: 760,
    margin: "20px auto 0",
    fontSize: 18,
    lineHeight: 1.7,
    color: "#475569",
  },
  sectionAlt: {
    padding: "60px 20px",
    background: "#f8fafc",
  },
  container: {
    maxWidth: 1200,
    margin: "0 auto",
  },
  gallery: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 14,
    marginBottom: 28,
  },
  galleryImage: {
    width: "100%",
    height: 260,
    objectFit: "cover",
    borderRadius: 18,
    border: "1px solid #e2e8f0",
  },
  photoPlaceholder: {
    minHeight: 260,
    borderRadius: 18,
    display: "grid",
    placeItems: "center",
    color: "#64748b",
    fontWeight: 800,
    background:
      "linear-gradient(135deg, rgba(15,23,42,0.08), rgba(59,130,246,0.12))",
    border: "1px solid #e2e8f0",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.3fr) minmax(320px, 0.7fr)",
    gap: 24,
    alignItems: "start",
  },
  infoCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 28,
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
  },
  sectionTitle: {
    margin: 0,
    fontSize: 28,
    fontWeight: 800,
  },
  infoList: {
    marginTop: 24,
    display: "grid",
    gap: 14,
  },
  infoItem: {
    display: "flex",
    justifyContent: "space-between",
    gap: 18,
    borderBottom: "1px solid #e2e8f0",
    paddingBottom: 14,
    color: "#334155",
  },
  bookingCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 24,
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
    position: "sticky",
    top: 92,
  },
  bookingTitle: {
    margin: 0,
    fontSize: 24,
    fontWeight: 800,
  },
  field: {
    marginTop: 16,
    display: "grid",
    gap: 8,
    fontSize: 14,
    fontWeight: 700,
    color: "#334155",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    fontSize: 15,
    outline: "none",
  },
  secondaryButton: {
    marginTop: 14,
    width: "100%",
    border: "1px solid #cbd5e1",
    borderRadius: 14,
    background: "#fff",
    color: "#0f172a",
    padding: "12px 16px",
    fontWeight: 800,
    fontSize: 15,
    cursor: "pointer",
  },
  secondaryButtonDisabled: {
    opacity: 0.65,
    cursor: "not-allowed",
  },
  availabilityBox: {
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.5,
  },
  availabilityBoxSuccess: {
    background: "#ecfdf5",
    border: "1px solid #bbf7d0",
    color: "#047857",
  },
  availabilityBoxError: {
    background: "#fff1f2",
    border: "1px solid #fecdd3",
    color: "#9f1239",
  },
  priceBox: {
    marginTop: 18,
    borderTop: "1px solid #e2e8f0",
    paddingTop: 16,
    display: "grid",
    gap: 10,
  },
  priceRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    color: "#475569",
  },
  totalRow: {
    marginTop: 8,
    paddingTop: 12,
    borderTop: "1px solid #e2e8f0",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 20,
    fontWeight: 800,
  },
  reserveButton: {
    marginTop: 18,
    width: "100%",
    border: "none",
    borderRadius: 14,
    background: "#0f172a",
    color: "#fff",
    padding: "14px 18px",
    fontWeight: 800,
    fontSize: 16,
    cursor: "pointer",
  },
  reserveButtonDisabled: {
    opacity: 0.65,
    cursor: "not-allowed",
  },
  disclaimer: {
    marginTop: 12,
    fontSize: 12,
    color: "#64748b",
    lineHeight: 1.5,
    textAlign: "center",
  },
  errorBox: {
    background: "#fff1f2",
    border: "1px solid #fecdd3",
    color: "#9f1239",
    borderRadius: 18,
    padding: 24,
    textAlign: "center",
    fontWeight: 700,
  },
  inlineError: {
    marginTop: 14,
    background: "#fff1f2",
    color: "#9f1239",
    border: "1px solid #fecdd3",
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    fontWeight: 700,
  },
  footer: {
    borderTop: "1px solid #e2e8f0",
    padding: "24px 20px",
    color: "#64748b",
    fontSize: 14,
    background: "#fff",
    textAlign: "center",
  },
};