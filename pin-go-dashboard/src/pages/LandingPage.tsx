import { Link } from "react-router-dom";
import { useMemo, useState } from "react";

type Lang = "es" | "en";

export default function LandingPage() {
  const [lang, setLang] = useState<Lang>("es");

  const t = useMemo(() => {
    return lang === "es"
      ? {
          navLogin: "Iniciar sesión",
          navSignup: "Crear cuenta",
          heroBadge: "Automatización inteligente para rentas a corto plazo",
          heroTitle: "Automatiza tus propiedades y elimina problemas de acceso",
          heroSubtitle:
            "Convierte cada cerradura en una operación automática: menos llamadas, menos errores y una mejor experiencia para tus huéspedes.",
          heroPricePrefix: "Desde",
          heroPriceLocks: "$9.99 / cerradura / mes",
          heroPriceSmart: "$14.99 / propiedad / mes",
          heroCtaPrimary: "Empezar ahora",
          heroCtaSecondary: "Iniciar sesión",
          heroTrust: " • Configuración en minutos",

          slogan: "Your lock works for you",

          sectionBenefitsTitle: "Todo en una sola plataforma",
          benefit1Title: "🔐 Control de acceso ",
          benefit1Text:
            "Códigos automáticos por reserva, NFC y revocación automática al check-out.",
          benefit2Title: "🏨 Sincronización con PMS",
          benefit2Text:
            "Integración con Guesty, Hostaway y Lodgify para operar sin trabajo manual.",
          benefit3Title: "🤖 Automatización inteligente",
          benefit3Text:
            "Automatiza aire acondicionado, luces y alarmas según la reserva.",
          benefit4Title: "📩 Mensajería",
          benefit4Text:
            "Mensajes automáticos pre-check-in, check-in y check-out para el huésped.",

          sectionDifferentiationTitle: "Más que códigos: control operativo real",
          sectionDifferentiationText:
            "Pin&Go no solo envía contraseña. Administra el ciclo completo de acceso, soporta tarjetas NFC y conecta control de acceso, PMS y automatización en una sola experiencia.",

          sectionPainTitle: "Diseñado para resolver problemas reales",
          pain1: "Huéspedes que no pueden entrar a la propiedad",
          pain2: "Llamadas a cualquier hora por códigos o accesos",
          pain3: "Check-ins manuales y operaciones desorganizadas",
          pain4: "Múltiples herramientas que no se comunican entre sí",

          sectionPricingTitle: "Pricing simple y claro",
          pricingLocksTitle: "🔐 Access Control",
          pricingLocksPrice: "$9.99",
          pricingLocksPeriod: "/ cerradura / mes",
          pricingLocksFeature1: "Códigos automáticos por reserva",
          pricingLocksFeature2: " Acceso tarjeta NFC",
          pricingLocksFeature3: "Check-in / check-out automático",
          pricingLocksFeature4: "Integración con PMS",
          pricingLocksFeature5: "Reduce llamadas de huéspedes",
          pricingLocksCta: "Comenzar",

          pricingSmartTitle: "🤖 Smart Automation",
          pricingSmartPrice: "$14.99",
          pricingSmartPeriod: "/ propiedad / mes",
          pricingSmartFeature1: "Control de dispositivos",
          pricingSmartFeature2: "Automatización por reserva",
          pricingSmartFeature3: "Experiencia premium del huésped",
          pricingSmartFeature4: "Integración con control de acceso",
          pricingSmartFeature5: "Mayor eficiencia operativa",
          pricingSmartCta: "Activar",

          exampleTitle: "Ejemplo de facturación",
          exampleText1: "10 cerraduras = $99.90 / mes",
          exampleText2: "5 propiedades inteligentes = $74.95 / mes",
          exampleText3: "Total = $174.85 / mes",

          faqTitle: "Preguntas frecuentes",
          faq1Q: "¿Necesito hardware especial?",
          faq1A:
            "Pin&Go está diseñado para integrarse con cerraduras inteligentes y flujos de acceso compatibles con TTLock.",
          faq2Q: "¿Puedo usarlo con mi PMS?",
          faq2A:
            "Sí. Pin&Go está diseñado para trabajar con integraciones PMS como Guesty, Hostaway y Lodgify.",
          faq3Q: "¿Puedo cancelar cuando quiera?",
          faq3A: "Sí. Puedes ajustar o cancelar tu servicio según tu operación.",
          faq4Q: "¿Es difícil configurarlo?",
          faq4A: "No. El flujo está pensado para una configuración rápida y fácil de operar.",              
          finalTitle: "Empieza hoy con Pin&Go",
          finalSubtitle:
            "Haz tus operaciones más simples, más seguras y más profesionales.",
          finalCta: "Crear cuenta",
          footerText: "© Pin&Go. Smart access for modern property operations.",
        }
      : {
          navLogin: "Log in",
          navSignup: "Create account",
          heroBadge: "Smart automation for short-term rentals",
          heroTitle: "Automate your properties and eliminate access issues",
          heroSubtitle:
            "Turn every lock into an automated operation: fewer calls, fewer errors, and a better guest experience.",
          heroPricePrefix: "Starting at",
          heroPriceLocks: "$9.99 / lock / month",
          heroPriceSmart: "$14.99 / property / month",
          heroCtaPrimary: "Get started",
          heroCtaSecondary: "Log in",
          heroTrust: " • Setup in minutes",

          slogan: "Your lock works for you",

          sectionBenefitsTitle: "Everything in one platform",
          benefit1Title: "🔐 Access Control",
          benefit1Text:
            "Automatic reservation-based codes, NFC, and automatic checkout revocation.",
          benefit2Title: "🏨 PMS Sync",
          benefit2Text:
            "Integrates with Guesty, Hostaway, and Lodgify to reduce manual work.",
          benefit3Title: "🤖 Smart Automation",
          benefit3Text:
            "Automate AC, lights, and alarms based on reservation activity.",
          benefit4Title: "📩 Messaging",
          benefit4Text:
            "Automatic pre-check-in, check-in, and checkout messaging for guests.",

          sectionDifferentiationTitle: "More than codes: real operational control",
          sectionDifferentiationText:
            "Pin&Go does more than send passwords. It manages the full access lifecycle, supports NFC, and connects access control, PMS, and automation in one experience.",

          sectionPainTitle: "Built to solve real problems",
          pain1: "Guests unable to enter the property",
          pain2: "Late-night calls about codes and access",
          pain3: "Manual check-ins and disorganized operations",
          pain4: "Multiple disconnected tools",

          sectionPricingTitle: "Simple, transparent pricing",
          pricingLocksTitle: "🔐 Access Control",
          pricingLocksPrice: "$9.99",
          pricingLocksPeriod: "/ lock / month",
          pricingLocksFeature1: "Automatic reservation-based codes",
          pricingLocksFeature2: "NFC access",
          pricingLocksFeature3: "Automatic check-in / check-out flow",
          pricingLocksFeature4: "PMS integration",
          pricingLocksFeature5: "Reduce guest support calls",
          pricingLocksCta: "Start now",

          pricingSmartTitle: "🤖 Smart Automation",
          pricingSmartPrice: "$14.99",
          pricingSmartPeriod: "/ property / month",
          pricingSmartFeature1: "Device control",
          pricingSmartFeature2: "Reservation-based automation",
          pricingSmartFeature3: "Premium guest experience",
          pricingSmartFeature4: "Access control integration",
          pricingSmartFeature5: "Higher operational efficiency",
          pricingSmartCta: "Activate",

          exampleTitle: "Billing example",
          exampleText1: "10 locks = $99.90 / month",
          exampleText2: "5 smart properties = $74.95 / month",
          exampleText3: "Total = $174.85 / month",

          faqTitle: "Frequently asked questions",
          faq1Q: "Do I need special hardware?",
          faq1A:
            "Pin&Go is designed to integrate with smart lock workflows compatible with TTLock.",
          faq2Q: "Can I use it with my PMS?",
          faq2A:
            "Yes. Pin&Go is designed to work with PMS integrations like Guesty, Hostaway, and Lodgify.",
          faq3Q: "Can I cancel anytime?",
          faq3A: "Yes. You can adjust or cancel your service based on your operation.",
          faq4Q: "Is setup difficult?",
          faq4A:
            "No. The flow is designed for fast setup and easy operation.",

          finalTitle: "Start with Pin&Go today",
          finalSubtitle:
            "Make your operations simpler, safer, and more professional.",
          finalCta: "Create account",
          footerText: "© Pin&Go. Smart access for modern property operations.",
        };
  }, [lang]);

    return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.brandWrap}>
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
                 <div style={styles.slogan}>{t.slogan}</div>
                </div>
          </div>
          
          <div style={styles.headerActions}>
            <div style={styles.langSwitcher}>
              <button
                type="button"
                onClick={() => setLang("es")}
                style={{
                  ...styles.langButton,
                  ...(lang === "es" ? styles.langButtonActive : {}),
                }}
              >
                ES
              </button>
              <button
                type="button"
                onClick={() => setLang("en")}
                style={{
                  ...styles.langButton,
                  ...(lang === "en" ? styles.langButtonActive : {}),
                }}
              >
                EN
              </button>
            </div>

            <Link to="/login" style={styles.linkGhost}>
              {t.navLogin}
            </Link>

            <Link to="/signup" style={styles.linkPrimary}>
              {t.navSignup}
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section style={styles.heroSection}>
          <div style={styles.heroContainer}>
            <div style={styles.badge}>{t.heroBadge}</div>

            <h1 style={styles.heroTitle}>{t.heroTitle}</h1>

            <p style={styles.heroSubtitle}>{t.heroSubtitle}</p>

            <div style={styles.priceGroup}>
              <div style={styles.priceLine}>
                {t.heroPricePrefix} <strong>{t.heroPriceLocks}</strong>
              </div>
              <div style={styles.priceLineSecondary}>{t.heroPriceSmart}</div>
            </div>

            <div style={styles.ctaRow}>
              <Link to="/signup" style={styles.ctaPrimary}>
                {t.heroCtaPrimary}
              </Link>

              <Link to="/login" style={styles.ctaSecondary}>
                {t.heroCtaSecondary}
              </Link>
            </div>

            <p style={styles.heroTrust}>{t.heroTrust}</p>
          </div>
        </section>

        <section style={styles.sectionAlt}>
          <div style={styles.container}>
            <h2 style={styles.sectionTitle}>{t.sectionBenefitsTitle}</h2>

            <div style={styles.featureGrid}>
              <FeatureCard title={t.benefit1Title} text={t.benefit1Text} />
              <FeatureCard title={t.benefit2Title} text={t.benefit2Text} />
              <FeatureCard title={t.benefit3Title} text={t.benefit3Text} />
              <FeatureCard title={t.benefit4Title} text={t.benefit4Text} />
            </div>
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.containerNarrow}>
            <h2 style={styles.sectionTitle}>{t.sectionDifferentiationTitle}</h2>
            <p style={styles.sectionText}>{t.sectionDifferentiationText}</p>
          </div>
        </section>

        <section style={styles.sectionAlt}>
          <div style={styles.container}>
            <h2 style={styles.sectionTitle}>{t.sectionPainTitle}</h2>

            <div style={styles.painGrid}>
              <PainCard text={t.pain1} />
              <PainCard text={t.pain2} />
              <PainCard text={t.pain3} />
              <PainCard text={t.pain4} />
            </div>
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.container}>
            <h2 style={styles.sectionTitle}>{t.sectionPricingTitle}</h2>

            <div style={styles.pricingGrid}>
              <div style={styles.pricingCard}>
                <h3 style={styles.pricingTitle}>{t.pricingLocksTitle}</h3>
                <div style={styles.pricingPrice}>{t.pricingLocksPrice}</div>
                <div style={styles.pricingPeriod}>{t.pricingLocksPeriod}</div>

                <ul style={styles.featureList}>
                  <li>{t.pricingLocksFeature1}</li>
                  <li>{t.pricingLocksFeature2}</li>
                  <li>{t.pricingLocksFeature3}</li>
                  <li>{t.pricingLocksFeature4}</li>
                  <li style={styles.highlightListItem}>{t.pricingLocksFeature5}</li>
                </ul>

                <Link to="/signup" style={styles.cardButton}>
                  {t.pricingLocksCta}
                </Link>
              </div>

              <div style={styles.pricingCard}>
                <h3 style={styles.pricingTitle}>{t.pricingSmartTitle}</h3>
                <div style={styles.pricingPrice}>{t.pricingSmartPrice}</div>
                <div style={styles.pricingPeriod}>{t.pricingSmartPeriod}</div>

                <ul style={styles.featureList}>
                  <li>{t.pricingSmartFeature1}</li>
                  <li>{t.pricingSmartFeature2}</li>
                  <li>{t.pricingSmartFeature3}</li>
                  <li>{t.pricingSmartFeature4}</li>
                  <li style={styles.highlightListItem}>{t.pricingSmartFeature5}</li>
                </ul>

                <Link to="/signup" style={styles.cardButton}>
                  {t.pricingSmartCta}
                </Link>
              </div>
            </div>

            <div style={styles.exampleBox}>
              <h3 style={styles.exampleTitle}>{t.exampleTitle}</h3>
              <p style={styles.exampleText}>{t.exampleText1}</p>
              <p style={styles.exampleText}>{t.exampleText2}</p>
              <p style={styles.exampleTotal}>{t.exampleText3}</p>
            </div>
          </div>
        </section>

        <section style={styles.sectionAlt}>
          <div style={styles.containerNarrow}>
            <h2 style={styles.sectionTitle}>{t.faqTitle}</h2>

            <div style={styles.faqList}>
              <FaqItem question={t.faq1Q} answer={t.faq1A} />
              <FaqItem question={t.faq2Q} answer={t.faq2A} />
              <FaqItem question={t.faq3Q} answer={t.faq3A} />
              <FaqItem question={t.faq4Q} answer={t.faq4A} />
            </div>
          </div>
        </section>

        <section style={styles.finalSection}>
          <div style={styles.containerNarrow}>
            <h2 style={styles.finalTitle}>{t.finalTitle}</h2>
            <p style={styles.finalSubtitle}>{t.finalSubtitle}</p>

            <Link to="/signup" style={styles.finalButton}>
              {t.finalCta}
            </Link>
          </div>
        </section>
      </main>
<footer style={styles.footer}>
  <div style={styles.container}>
    <div>{t.footerText}</div>

    <div style={{ marginTop: 8 }}>
      <Link
        to="/legal/terms"
        style={{ color: "#64748b", textDecoration: "none", marginRight: 12 }}
      >
        Terms
      </Link>

      <Link
        to="/legal/privacy"
        style={{ color: "#64748b", textDecoration: "none" }}
      >
        Privacy
      </Link>
    </div>
  </div>
</footer>

         </div>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div style={styles.featureCard}>
      <h3 style={styles.featureTitle}>{title}</h3>
      <p style={styles.featureText}>{text}</p>
    </div>
  );
}

function PainCard({ text }: { text: string }) {
  return (
    <div style={styles.painCard}>
      <span style={styles.painIcon}>•</span>
      <span>{text}</span>
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  return (
    <div style={styles.faqItem}>
      <h3 style={styles.faqQuestion}>{question}</h3>
      <p style={styles.faqAnswer}>{answer}</p>
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
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  },
  brandWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
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
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  langSwitcher: {
    display: "flex",
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    overflow: "hidden",
  },
  langButton: {
    padding: "8px 12px",
    border: "none",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 600,
    color: "#334155",
  },
  langButtonActive: {
    background: "#0f172a",
    color: "#fff",
  },
  linkGhost: {
    textDecoration: "none",
    color: "#0f172a",
    padding: "10px 14px",
    borderRadius: 10,
    fontWeight: 600,
  },
  linkPrimary: {
    textDecoration: "none",
    background: "#0f172a",
    color: "#ffffff",
    padding: "10px 16px",
    borderRadius: 10,
    fontWeight: 700,
  },
  heroSection: {
    padding: "84px 20px 72px",
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
    fontSize: "clamp(2.2rem, 5vw, 4rem)",
    lineHeight: 1.05,
    fontWeight: 800,
    margin: 0,
  },
  heroSubtitle: {
    maxWidth: 760,
    margin: "22px auto 0",
    fontSize: 19,
    lineHeight: 1.7,
    color: "#475569",
  },
  priceGroup: {
    marginTop: 28,
  },
  priceLine: {
    fontSize: 24,
    color: "#0f172a",
  },
  priceLineSecondary: {
    marginTop: 8,
    fontSize: 18,
    color: "#475569",
  },
  ctaRow: {
    marginTop: 30,
    display: "flex",
    justifyContent: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  ctaPrimary: {
    textDecoration: "none",
    background: "#0f172a",
    color: "#fff",
    padding: "14px 22px",
    borderRadius: 12,
    fontWeight: 700,
  },
  ctaSecondary: {
    textDecoration: "none",
    background: "#fff",
    color: "#0f172a",
    padding: "14px 22px",
    borderRadius: 12,
    fontWeight: 700,
    border: "1px solid #cbd5e1",
  },
  heroTrust: {
    marginTop: 14,
    color: "#64748b",
    fontSize: 14,
  },
  section: {
    padding: "80px 20px",
  },
  sectionAlt: {
    padding: "80px 20px",
    background: "#f8fafc",
  },
  container: {
    maxWidth: 1200,
    margin: "0 auto",
  },
  containerNarrow: {
    maxWidth: 860,
    margin: "0 auto",
    textAlign: "center",
  },
  sectionTitle: {
    fontSize: "clamp(1.8rem, 4vw, 2.4rem)",
    fontWeight: 800,
    margin: 0,
    textAlign: "center",
  },
  sectionText: {
    fontSize: 18,
    lineHeight: 1.8,
    color: "#475569",
    marginTop: 18,
  },
  featureGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 20,
    marginTop: 36,
  },
  featureCard: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 24,
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)",
  },
  featureTitle: {
    margin: 0,
    fontSize: 20,
  },
  featureText: {
    marginTop: 12,
    color: "#475569",
    lineHeight: 1.7,
    fontSize: 15,
  },
  painGrid: {
    marginTop: 36,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 16,
  },
  painCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 18,
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    lineHeight: 1.6,
  },
  painIcon: {
    color: "#dc2626",
    fontWeight: 700,
    fontSize: 20,
    lineHeight: 1,
  },
  pricingGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: 24,
    marginTop: 40,
  },
  pricingCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 28,
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
  },
  pricingTitle: {
    fontSize: 24,
    margin: 0,
  },
  pricingPrice: {
    marginTop: 18,
    fontSize: 42,
    fontWeight: 800,
  },
  pricingPeriod: {
    marginTop: 4,
    color: "#64748b",
  },
  featureList: {
    marginTop: 22,
    marginBottom: 24,
    paddingLeft: 18,
    color: "#334155",
    lineHeight: 1.9,
  },
  highlightListItem: {
    color: "#16a34a",
    fontWeight: 700,
  },
  cardButton: {
    display: "inline-block",
    textDecoration: "none",
    background: "#0f172a",
    color: "#fff",
    padding: "12px 18px",
    borderRadius: 12,
    fontWeight: 700,
  },
  exampleBox: {
    marginTop: 34,
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 18,
    padding: 24,
    textAlign: "center",
    maxWidth: 720,
    marginInline: "auto",
  },
  exampleTitle: {
    margin: 0,
    fontSize: 22,
    fontWeight: 800,
  },
  exampleText: {
    margin: "10px 0 0",
    color: "#334155",
    fontSize: 17,
  },
  exampleTotal: {
    margin: "14px 0 0",
    fontSize: 20,
    fontWeight: 800,
    color: "#0f172a",
  },
  faqList: {
    marginTop: 36,
    display: "grid",
    gap: 18,
    textAlign: "left",
  },
  faqItem: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 22,
  },
  faqQuestion: {
    margin: 0,
    fontSize: 18,
  },
  faqAnswer: {
    marginTop: 10,
    color: "#475569",
    lineHeight: 1.7,
  },
  finalSection: {
    padding: "90px 20px",
    background: "#0f172a",
    color: "#fff",
    textAlign: "center",
  },
  finalTitle: {
    margin: 0,
    fontSize: "clamp(2rem, 4vw, 3rem)",
    fontWeight: 800,
  },
  finalSubtitle: {
    marginTop: 16,
    color: "#cbd5e1",
    fontSize: 18,
    lineHeight: 1.7,
  },
  finalButton: {
    display: "inline-block",
    marginTop: 26,
    textDecoration: "none",
    background: "#fff",
    color: "#0f172a",
    padding: "14px 24px",
    borderRadius: 12,
    fontWeight: 800,
  },
  footer: {
    borderTop: "1px solid #e2e8f0",
    padding: "24px 20px",
    color: "#64748b",
    fontSize: 14,
    background: "#fff",
  },
};