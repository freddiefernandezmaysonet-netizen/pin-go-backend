import { Link } from "react-router-dom";

export default function PublicBookingCancelPage() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.icon}>⚠️</div>

        <h1 style={styles.title}>
          Reservation Not Completed
        </h1>

        <p style={styles.text}>
          Your payment was cancelled before completion.
        </p>

        <p style={styles.text}>
          No charges were made.
        </p>

        <p style={styles.text}>
          The property may still be available if you wish to complete your booking.
        </p>

        <Link to="/" style={styles.button}>
          Return Home
        </Link>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#f8fafc",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, sans-serif',
  },
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 40,
    maxWidth: 700,
    width: "100%",
    textAlign: "center",
  },
  icon: {
    fontSize: 64,
  },
  title: {
    marginTop: 20,
    marginBottom: 16,
    fontSize: 36,
    fontWeight: 800,
  },
  text: {
    color: "#475569",
    lineHeight: 1.8,
    fontSize: 16,
  },
  button: {
    display: "inline-block",
    marginTop: 24,
    background: "#0f172a",
    color: "#fff",
    textDecoration: "none",
    padding: "14px 22px",
    borderRadius: 12,
    fontWeight: 700,
  },
};