import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";
type Message = { id: string; text: string; sender: "guest" | "property"; insertedAt: string; attachments: string[] };
type Thread = { id: string; title: string; provider: string; isClosed: boolean; bookingId: string | null; messageCount: number };
type List<T> = { items: T[]; page: number; limit: number; total: number };
class InboxFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}/api/dashboard/channex-messages${path}`, {
    ...init, credentials: "include", signal,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 401) { window.location.assign("/login"); throw new InboxFailure("UNAUTHENTICATED"); }
  const data = await response.json();
  if (!response.ok) throw new InboxFailure(data.error ?? "HOST_INBOX_UNAVAILABLE");
  return data as T;
}
function errorText(error: unknown) {
  if (error instanceof InboxFailure) {
    if (error.code === "HOST_INBOX_DISABLED") return "La bandeja de canales todavía no está activada.";
    if (error.code === "HOST_INBOX_FORBIDDEN") return "Esta bandeja está disponible para administradores de la propiedad.";
    if (error.code === "HOST_INBOX_APPLICATION_UNAVAILABLE") return "Messages aún no está disponible para esta propiedad en Channex.";
    if (error.code === "HOST_INBOX_SEND_OUTCOME_UNKNOWN") return "No pudimos confirmar el envío. Actualiza el historial y verifica si aparece tu respuesta antes de escribirla otra vez.";
    if (error.code === "HOST_INBOX_THREAD_CLOSED") return "Esta conversación está cerrada.";
    if (error.code === "HOST_INBOX_RATE_LIMITED") return "El canal está recibiendo muchas solicitudes. Intenta actualizar en unos minutos.";
  }
  return "No pudimos completar la solicitud. Actualiza para volver a consultar.";
}
export default function ChannexInbox() {
  const { user } = useAuth();
  const actor = `${user?.orgId ?? ""}:${user?.id ?? ""}`;
  return <HostInbox key={actor} actor={actor} />;
}
function HostInbox({ actor }: { actor: string }) {
  const client = useQueryClient();
  const [property, setProperty] = useState("");
  const [selected, setSelected] = useState<Thread | null>(null);
  const [threadPage, setThreadPage] = useState(1), [messagePage, setMessagePage] = useState(1);
  const [text, setText] = useState(""), [sending, setSending] = useState(false), [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const properties = useQuery({ queryKey: ["channex-inbox-properties", actor], queryFn: ({ signal }) => request<{ items: { id: string; name: string }[] }>("/properties", signal), retry: false });
  const path = `/properties/${encodeURIComponent(property)}/threads`;
  const threads = useQuery({ queryKey: ["channex-inbox-threads", actor, property, threadPage], enabled: Boolean(property), retry: false,
    queryFn: ({ signal }) => request<List<Thread>>(`${path}?page=${threadPage}&limit=25`, signal) });
  const messages = useQuery({ queryKey: ["channex-inbox-messages", actor, property, selected?.id, messagePage], enabled: Boolean(property && selected), retry: false,
    queryFn: ({ signal }) => request<List<Message> & { thread: Thread }>(`${path}/${selected!.id}/messages?page=${messagePage}&limit=25`, signal) });
  useEffect(() => { setText(""); setNotice(""); setUncertain(false); }, [property, selected?.id]);
  const current = messages.data?.thread ?? selected;
  async function send() {
    if (!selected || sending || uncertain || !text.trim()) return;
    setSending(true); setNotice("");
    // Retain the same key and text after any failure, including browser/network failures.
    const storageKey = `channex-reply:v1:${actor}:${property}:${selected.id}`;
    try {
      const saved = sessionStorage.getItem(storageKey);
      const pending = saved ? JSON.parse(saved) as { key: string; text: string } : { key: crypto.randomUUID(), text };
      if (pending.text !== text) { setUncertain(true); setNotice("Hay una respuesta pendiente de confirmar. Verifica primero el historial de esta conversación."); return; }
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      await request(`${path}/${selected.id}/messages`, undefined, { method: "POST", headers: { "idempotency-key": pending.key }, body: JSON.stringify({ text: pending.text }) });
      sessionStorage.removeItem(storageKey); setText(""); setMessagePage(1); setNotice("Respuesta aceptada por Channex.");
      await Promise.all([client.invalidateQueries({ queryKey: ["channex-inbox-messages", actor, property, selected.id] }), client.invalidateQueries({ queryKey: ["channex-inbox-threads", actor, property] })]);
    } catch (error) { setUncertain(true); setNotice(errorText(error)); }
    finally { setSending(false); }
  }
  const box = { border: "1px solid #e5e7eb", borderRadius: 16, padding: 18, background: "#fff" };
  return <section style={box} aria-label="Conversaciones de canales">
    <h2 style={{ marginTop: 0 }}>Conversaciones con huéspedes</h2>
    <p>Lee y responde mensajes de Airbnb, Booking.com y Expedia.</p>
    {properties.isPending && <p role="status">Cargando propiedades…</p>}
    {properties.error && <p role="alert">{errorText(properties.error)}</p>}
    {properties.data && <label>Propiedad <select disabled={sending} value={property} onChange={e => { setProperty(e.target.value); setSelected(null); setThreadPage(1); setMessagePage(1); }}>
      <option value="">Selecciona una propiedad</option>
      {properties.data.items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>}
    {properties.data?.items.length === 0 && <p>No hay propiedades publicadas disponibles.</p>}
    {property && <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 16 }}>
      <aside style={{ flex: "1 1 260px" }} aria-label="Lista de conversaciones">
        <button disabled={sending || threads.isFetching} onClick={() => void threads.refetch()}>Actualizar conversaciones</button>
        {threads.isPending && <p role="status">Cargando conversaciones…</p>}
        {threads.error && <p role="alert">{errorText(threads.error)}</p>}
        {threads.data?.items.length === 0 && <p>No hay conversaciones en esta página.</p>}
        {threads.data?.items.map(t => <button key={t.id} disabled={sending} aria-pressed={selected?.id === t.id}
          style={{ display: "block", width: "100%", textAlign: "left", padding: 12, marginTop: 8 }}
          onClick={() => { setSelected(t); setMessagePage(1); }}>
          <strong>{t.title}</strong><br />{t.provider} · {t.bookingId ? "Reserva" : "Consulta sin reserva"}{t.isClosed ? " · Cerrada" : ""}
        </button>)}
        <nav aria-label="Páginas de conversaciones" style={{ marginTop: 12 }}>
          <button disabled={sending || threadPage === 1 || threads.isFetching} onClick={() => setThreadPage(p => p - 1)}>Anterior</button>
          <span> Página {threadPage} </span>
          <button disabled={sending || !threads.data || threadPage * 25 >= threads.data.total || threads.isFetching} onClick={() => setThreadPage(p => p + 1)}>Siguiente</button>
        </nav>
      </aside>
      <div style={{ flex: "2 1 340px", minWidth: 0 }}>
        {!selected && <p>Selecciona una conversación para ver sus mensajes.</p>}
        {selected && <>
          <h3>{current?.title}</h3>
          <button disabled={sending || messages.isFetching} onClick={() => void messages.refetch()}>Actualizar historial</button>
          {messages.isPending && <p role="status">Cargando mensajes…</p>}
          {messages.error && <p role="alert">{errorText(messages.error)}</p>}
          {messages.data?.items.length === 0 && <p>Esta conversación aún no tiene mensajes.</p>}
          {[...(messages.data?.items ?? [])].reverse().map(m => <article key={m.id} style={{ ...box, marginTop: 10, background: m.sender === "property" ? "#f0fdf4" : "#f9fafb" }}>
            <strong>{m.sender === "property" ? "Propiedad" : "Huésped"}</strong> · <time dateTime={m.insertedAt}>{new Date(m.insertedAt).toLocaleString()}</time>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.text}</p>
            {m.attachments.length > 0 && <p>{m.attachments.length} adjunto(s) en el canal.</p>}
          </article>)}
          <nav aria-label="Páginas del historial" style={{ margin: "12px 0" }}>
            <button disabled={sending || messagePage === 1 || messages.isFetching} onClick={() => setMessagePage(p => p - 1)}>Más recientes</button>
            <span> Página {messagePage} </span>
            <button disabled={sending || !messages.data || messagePage * 25 >= messages.data.total || messages.isFetching} onClick={() => setMessagePage(p => p + 1)}>Más antiguos</button>
          </nav>
          {current?.isClosed ? <p>Conversación cerrada.</p> : <form onSubmit={e => { e.preventDefault(); void send(); }}>
            <label htmlFor="channel-reply">Tu respuesta</label>
            <textarea id="channel-reply" value={text} maxLength={5000} disabled={sending || uncertain} onChange={e => setText(e.target.value)} style={{ display: "block", width: "100%", minHeight: 100 }} />
            <button disabled={sending || uncertain || !text.trim() || !messages.data || Boolean(messages.error)}>{sending ? "Enviando…" : "Enviar respuesta"}</button>
          </form>}
          {notice && <p role="status">{notice}</p>}
        </>}
      </div>
    </div>}
  </section>;
}
