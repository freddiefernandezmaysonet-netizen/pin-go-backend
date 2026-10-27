import { preferenceNames as preferenceLabels, type PropertyFacts } from '../property-facts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ArrowRight, CalendarDays, Check, ChevronRight, Compass, CreditCard, Globe2, LogOut, MapPin, Search, ShieldCheck, Sparkles, Users, Wifi, X } from 'lucide-react';

type Criteria = { destination: string | null; checkIn: string | null; checkOut: string | null; adults: number | null; children: number; infants: number; maxTotal: number | null; currency: 'USD'; nfc: boolean; minBedrooms: number | null; minFullBathrooms: number | null; preferences: string[]; unsupported: string[] };
type Result = { property: { id: string; name: string; location: string; photos: string[]; maxGuests: number; features: string[]; nfcVerified: boolean; minimumAge: number | null; details?: PropertyFacts }; quote: { currency: string; nights: number; nightlySubtotal: number; cleaningFee: number; amenitiesTotal: number; taxesTotal: number; totalAmount: number }; checkedAt: string };
type Turn = { role: 'user' | 'assistant'; content: string };
type SavedTrip = { id: string; title: string; status: 'PLANNING'; criteria: Criteria; createdAt: string; updatedAt: string };
type Answer = { criteria: Criteria; clarification: string | null; missing: string[]; results: Result[]; status: string; failed: number; reply: string; replyFallback: boolean };
const initial: Criteria = { destination: null, checkIn: null, checkOut: null, adults: null, children: 0, infants: 0, maxTotal: null, currency: 'USD', nfc: false, minBedrooms: null, minFullBathrooms: null, preferences: [], unsupported: [] };
async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(65000) });
  const data = await r.json();
  if (!r.ok) throw new Error(r.status === 401 ? 'SESSION_REQUIRED' : data.error || 'UNAVAILABLE');
  return data;
}
export function PrimeDashboard() {
  const [lang, setLang] = useState<'es' | 'en'>('es');
  const t = (es: string, en: string) => lang === 'es' ? es : en;
  const [member, setMember] = useState<{ name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [invitation, setInvitation] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [page, setPage] = useState<'explore' | 'card' | 'trips'>('explore');
  const [criteria, setCriteria] = useState<Criteria>(initial);
  const [message, setMessage] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<Result | null>(null);
  const [filters, setFilters] = useState(false);
  const [savedTrips, setSavedTrips] = useState<SavedTrip[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState('');
  const [planNotice, setPlanNotice] = useState('');
  const [saveForm, setSaveForm] = useState(false);
  const [planTitle, setPlanTitle] = useState('');
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [deletePlanId, setDeletePlanId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const token = new URLSearchParams(location.hash.slice(1)).get('invitation');
    (async () => {
      try {
        if (token) { await api('session', 'POST', { invitation: token }); history.replaceState(null, '', location.pathname); }
        const profile = await api('member');
        if (active) setMember(profile);
      } catch { if (active && token) setLoginError(true); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (detail) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [detail]);
  useEffect(() => { const log = conversationRef.current; if (log) log.scrollTop = log.scrollHeight; }, [turns, busy, page]);
  useEffect(() => {
    if (!member || page !== 'trips') return;
    let active = true;
    setPlansLoading(true); setPlanError('');
    api('saved-trips').then(data => { if (active) setSavedTrips(data.trips); }).catch(e => {
      if (active) { if (e instanceof Error && e.message === 'SESSION_REQUIRED') setMember(null); setPlanError('LOAD'); }
    }).finally(() => { if (active) setPlansLoading(false); });
    return () => { active = false; };
  }, [member, page]);
  async function signOut() {
    try { await api('session', 'DELETE'); setMember(null); setAnswer(null); setCriteria(initial); setTurns([]); setMessage(''); setDetail(null); setSavedTrips([]); setActivePlanId(null); setSaveForm(false); setPlanTitle(''); setPlanNotice(''); setPlanError(''); setDeletePlanId(null); }
    catch { setError(t('No pudimos cerrar la sesión. Intenta otra vez.', 'Could not sign out. Try again.')); }
  }
  async function login(e: FormEvent) {
    e.preventDefault(); setLoading(true); setLoginError(false);
    try { await api('session', 'POST', { invitation: invitation.trim() }); setMember(await api('member')); setInvitation(''); }
    catch { setLoginError(true); }
    finally { setLoading(false); }
  }
  function edit<K extends keyof Criteria>(key: K, value: Criteria[K]) { setCriteria(c => ({ ...c, [key]: value })); setAnswer(null); setError(''); setPlanNotice(''); }
  const hasTripDetails = !!(criteria.destination || criteria.checkIn || criteria.checkOut || criteria.adults || criteria.children || criteria.infants || criteria.maxTotal || criteria.nfc || criteria.preferences.length || criteria.unsupported.length || criteria.minBedrooms != null || criteria.minFullBathrooms != null);
  async function saveTrip(e: FormEvent) {
    e.preventDefault(); if (busy || planBusy || !hasTripDetails) return;
    setPlanBusy(true); setPlanError(''); setPlanNotice('');
    try {
      const result = await api('saved-trips' + (activePlanId ? '/' + activePlanId : ''), activePlanId ? 'PUT' : 'POST', { title: planTitle.trim(), criteria });
      setSavedTrips(previous => [result.trip, ...previous.filter(p => p.id !== result.trip.id)]);
      setActivePlanId(result.trip.id); setPlanTitle(result.trip.title); setSaveForm(false); setPlanNotice('SAVED');
    } catch (e) { const code = e instanceof Error ? e.message : ''; if (code === 'SESSION_REQUIRED') setMember(null); if (code === 'TRIP_NOT_FOUND') setActivePlanId(null); setPlanError(code === 'SAVED_TRIP_LIMIT' ? 'LIMIT' : code === 'TRIP_NOT_FOUND' ? 'MISSING' : 'SAVE'); }
    finally { setPlanBusy(false); }
  }
  async function deleteTrip(plan: SavedTrip) {
    if (planBusy || busy) return;
    setPlanBusy(true); setPlanError('');
    try {
      await api('saved-trips/' + plan.id, 'DELETE');
      setSavedTrips(previous => previous.filter(p => p.id !== plan.id)); setDeletePlanId(null);
      if (activePlanId === plan.id) { setActivePlanId(null); setPlanNotice(''); }
    } catch (e) { if (e instanceof Error && e.message === 'SESSION_REQUIRED') setMember(null); setPlanError('DELETE'); }
    finally { setPlanBusy(false); }
  }
  function resumeTrip(plan: SavedTrip) {
    if (busy || planBusy) return;
    setPage('explore'); setCriteria(plan.criteria); setTurns([]); setMessage(''); setActivePlanId(plan.id); setPlanTitle(plan.title); setSaveForm(false); setFilters(false); setDetail(null); setPlanError('');
    void search(undefined, plan.criteria, [], t('Retomemos mi viaje: ', 'Let’s resume my trip: ') + plan.title);
  }
  const planErrorText = planError === 'LIMIT' ? t('Puedes guardar hasta 20 planes. Elimina uno antes de añadir otro.', 'You can save up to 20 plans. Remove one before adding another.') : planError === 'MISSING' ? t('Este plan fue eliminado. Puedes guardar estos requisitos como un nuevo plan.', 'This plan was removed. You can save these requirements as a new plan.') : t('No pudimos completar la operación con tus planes. Vuelve a intentarlo.', 'We couldn’t complete the operation on your plans. Please retry.');
  async function search(text?: string, searchCriteria = criteria, context = turns, label?: string) {
    if (busy || planBusy) return;
    setBusy(true); setError(''); setAnswer(null); setPlanNotice('');
    const userTurn: Turn = { role: 'user', content: text || label || t('Actualicé los datos de mi viaje. Consulta estas opciones.', 'I updated my trip details. Check these options.') };
    setTurns(previous => [...previous, userTurn]);
    setMessage('');
    try {
      const result: Answer = await api('search', 'POST', { criteria: searchCriteria, history: context.slice(-12), language: lang, ...(text ? { message: text } : {}) });
      setCriteria(result.criteria); setAnswer(result);
      setTurns(previous => [...previous, { role: 'assistant', content: result.reply }]);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (code === 'SESSION_REQUIRED') setMember(null);
      if (text) setMessage(text);
      setError(code === 'PILOT_DAILY_LIMIT' ? t('Alcanzaste las 100 consultas con IA del piloto de hoy. Puedes seguir usando los filtros.', 'Today’s 100 AI pilot searches have been used. You can still use filters.') : t('No pudimos completar esta búsqueda. Inténtalo de nuevo; no se creó ninguna reservación.', 'We couldn’t complete this search. Please try again; no reservation was created.'));
    } finally { setBusy(false); }
  }
  const preferenceNames: Record<string, string> = Object.fromEntries(Object.entries(preferenceLabels).map(([key, labels]) => [key, labels[lang === 'es' ? 0 : 1]]));
  const money = (v: number) => new Intl.NumberFormat(lang === 'es' ? 'es-PR' : 'en-US', { style: 'currency', currency: 'USD' }).format(v);
  const example = t('Me gustaría una escapada en Puerto Rico, cerca de la playa y con piscina privada.', 'I would love a getaway in Puerto Rico, near the beach with a private pool.');
  if (!member) return <main className="prime-login"><div className="prime-login-card"><Brand /><span className="prime-eyebrow">PRIME · {t('PILOTO PRIVADO', 'PRIVATE PILOT')}</span><h1>{t('Tu próxima forma de viajar.', 'Your next way to travel.')}</h1><p>{t('Un solo lugar para descubrir estancias, planificar tu viaje y llevar tu membresía contigo.', 'One place to discover stays, plan your trip, and take your membership with you.')}</p>{loading ? <p role="status">{t('Abriendo tu espacio…', 'Opening your space…')}</p> : <form onSubmit={login}><label htmlFor="invitation">{t('Código de invitación', 'Invitation code')}</label><input id="invitation" type="password" autoComplete="off" value={invitation} onChange={e => setInvitation(e.target.value)} required /><button className="prime-primary" type="submit">{t('Entrar a Prime', 'Enter Prime')}<ArrowRight size={18} /></button>{loginError ? <p role="alert">{t('No pudimos validar la invitación. Abre el enlace privado completo o revisa el código.', 'We couldn’t validate the invitation. Open the complete private link or check the code.')}</p> : null}</form>}<small>{t('Acceso de prueba. Membresía comercial todavía no disponible.', 'Test access. Commercial membership is not available yet.')}</small></div></main>;
  return <div className="prime-app">
    <aside className="prime-sidebar"><Brand /><div className="prime-sidebar-label">{t('TU ESPACIO', 'YOUR SPACE')}</div><nav aria-label={t('Navegación de Prime', 'Prime navigation')}>
      {[['explore', Compass, t('Explorar', 'Explore')], ['trips', CalendarDays, t('Mis viajes', 'My trips')], ['card', CreditCard, t('Mi tarjeta Prime', 'My Prime card')]].map(([key, Icon, label]) => { const I = Icon as typeof Compass; return <button key={String(key)} className={page === key ? 'active' : ''} aria-current={page === key ? 'page' : undefined} onClick={() => setPage(key as typeof page)}><I size={19} />{String(label)}{page === key ? <span className="prime-nav-dot" /> : null}</button>; })}
    </nav><div className="prime-sidebar-bottom"><div className="prime-avatar">F</div><div><strong>{member.name}</strong><small>{t('Miembro de prueba', 'Pilot member')}</small></div><button className="prime-icon-button" aria-label={t('Cerrar sesión', 'Sign out')} onClick={signOut}><LogOut size={17} /></button></div></aside>
    <div className="prime-content"><header className="prime-topbar"><span>Pin&Go <strong>Prime</strong><span className="prime-pilot-badge">{t('Vista de prueba', 'Pilot preview')}</span></span><div className="prime-topbar-actions"><button className="prime-language" onClick={() => setLang(l => l === 'es' ? 'en' : 'es')}><Globe2 size={16} />{lang === 'es' ? 'English' : 'Español'}</button><button className="prime-icon-button" aria-label={t('Cerrar sesión', 'Sign out')} onClick={signOut}><LogOut size={16} /></button></div></header>
    <main className="prime-main">
      {page === 'explore' ? <>
        <div className="prime-welcome"><span className="prime-eyebrow">{t('HOLA, FREDDIE', 'HELLO, FREDDIE')} <span>✦</span></span><h1>{t('Tu próxima estancia', 'Your next stay')}<br /><em>{t('empieza con una idea.', 'starts with an idea.')}</em></h1><p>{t('Tú imaginas el viaje. Pin AI te ayuda a encontrarlo.', 'You imagine the trip. Pin AI helps you find it.')}</p></div>
        <section className="prime-search-box" aria-label={t('Conversación con Pin AI', 'Conversation with Pin AI')}>
          <div className="prime-ai-label"><span className="prime-ai-symbol"><Sparkles size={17} /></span><strong>Pin AI</strong><span>{t('Tu compañero de viaje', 'Your travel companion')}</span>{turns.length || hasTripDetails ? <button className="prime-new-conversation" disabled={busy || planBusy} onClick={() => { setTurns([]); setCriteria(initial); setAnswer(null); setError(''); setMessage(''); setFilters(false); setActivePlanId(null); setPlanTitle(''); setSaveForm(false); setPlanNotice(''); setPlanError(''); inputRef.current?.focus(); }}>{t('Nuevo viaje', 'New trip')}</button> : null}</div>
          <div className="prime-conversation" ref={conversationRef} role="log" aria-label={t('Conversación', 'Conversation')} aria-live="polite" aria-relevant="additions text">
            <div className="prime-turn prime-turn-assistant"><span>Pin AI</span><p>{t('Cuéntame cómo imaginas tus próximas vacaciones. Podemos ir afinando el destino, las fechas y lo que no puede faltar, paso a paso.', 'Tell me how you imagine your next vacation. We can work out the destination, dates, and must-haves together, step by step.')}</p></div>
            {turns.map((turn, index) => <div className={'prime-turn prime-turn-' + turn.role} key={index}><span>{turn.role === 'assistant' ? 'Pin AI' : t('Tú', 'You')}</span><p>{turn.content}</p></div>)}
            {busy ? <div className="prime-turn prime-turn-assistant prime-thinking" role="status"><Sparkles size={16} /><span>{t('Pin AI está preparando tu respuesta…', 'Pin AI is preparing your reply…')}</span></div> : null}
          </div>
          <form onSubmit={e => { e.preventDefault(); if (message.trim()) void search(message.trim()); }}><label className="sr-only" htmlFor="prime-prompt">{t('Describe tu viaje', 'Describe your trip')}</label><textarea ref={inputRef} id="prime-prompt" value={message} disabled={busy || planBusy} onChange={e => setMessage(e.target.value)} placeholder={turns.length ? t('Sigue conversando con Pin AI…', 'Keep chatting with Pin AI…') : t('Quiero unos días cerca de la playa…', 'I would love a few days near the beach…')} maxLength={1600} rows={2} /><div className="prime-composer-footer"><span><ShieldCheck size={14} />{t('Solo propiedades del piloto Prime', 'Prime pilot properties only')}</span><button type="submit" disabled={busy || planBusy || !message.trim()} aria-label={t('Enviar a Pin AI', 'Send to Pin AI')}><ArrowUp size={22} /></button></div></form>
        </section>
        {!turns.length ? <div className="prime-suggestions"><span>{t('Prueba con', 'Try this')}</span><button disabled={busy || planBusy} onClick={() => { setMessage(example); inputRef.current?.focus(); }}>{t('Una escapada a Puerto Rico', 'A Puerto Rico getaway')}<ArrowRight size={14} /></button><button disabled={busy || planBusy} onClick={() => { setMessage(t('Quiero usar mi tarjeta Prime en mi estancia.', 'I want to use my Prime card during my stay.')); inputRef.current?.focus(); }}><CreditCard size={14} />{t('Viajar con mi tarjeta', 'Travel with my card')}</button></div> : null}
        <p className="prime-privacy">{t('Pin AI usa tus mensajes recientes y los datos de tu viaje con OpenAI para responderte. La conversación se reinicia al recargar. Solo se conservan los requisitos que guardes con «Guardar viaje». No incluyas información sensible.', 'Pin AI uses your recent messages and trip details with OpenAI to respond. The conversation resets on reload. Only the requirements you save with “Save trip” are kept. Do not include sensitive information.')}</p>
        <section className="prime-filter-section"><div className="prime-section-head"><h2>{t('Lo que vamos planeando', 'Your trip so far')}</h2><button disabled={busy || planBusy} onClick={() => setFilters(v => !v)} aria-expanded={filters}>{filters ? t('Ocultar detalles', 'Hide details') : t('Ver y editar detalles', 'View and edit details')}<ChevronRight size={15} /></button></div>
          {filters ? <form onSubmit={e => { e.preventDefault(); void search(); }}><fieldset disabled={busy || planBusy} className="prime-filter-fieldset"><div className="prime-filters">
            <label><span><MapPin size={14} />{t('Destino', 'Destination')}</span><input value={criteria.destination || ''} onChange={e => edit('destination', e.target.value || null)} placeholder="Puerto Rico" /></label>
            <label><span>{t('Entrada', 'Check-in')}</span><input type="date" value={criteria.checkIn || ''} onChange={e => edit('checkIn', e.target.value || null)} /></label>
            <label><span>{t('Salida', 'Check-out')}</span><input type="date" value={criteria.checkOut || ''} onChange={e => edit('checkOut', e.target.value || null)} /></label>
            <label><span><Users size={14} />{t('Adultos', 'Adults')}</span><input type="number" min="1" max="30" value={criteria.adults ?? ''} onChange={e => edit('adults', e.target.value ? Number(e.target.value) : null)} placeholder="2" /></label>
            <button type="submit" className="prime-filter-search" aria-label={t('Consultar disponibilidad', 'Check availability')}><Search size={20} /></button>
          </div>{filters ? <div className="prime-extra-filters"><label>{t('Niños', 'Children')}<input type="number" min="0" max="20" value={criteria.children} onChange={e => edit('children', Number(e.target.value))} /></label><label>{t('Infantes', 'Infants')}<input type="number" min="0" max="10" value={criteria.infants} onChange={e => edit('infants', Number(e.target.value))} /></label><label>{t('Presupuesto total · USD', 'Total budget · USD')}<input type="number" min="1" max="100000" value={criteria.maxTotal ?? ''} placeholder={t('Sin límite', 'No limit')} onChange={e => edit('maxTotal', e.target.value ? Number(e.target.value) : null)} /></label><label>{t('Habitaciones mínimas', 'Minimum bedrooms')}<input type="number" min="0" max="100" value={criteria.minBedrooms ?? ''} placeholder={t('Sin mínimo', 'No minimum')} onChange={e => edit('minBedrooms', e.target.value ? Number(e.target.value) : null)} /></label><label>{t('Baños completos mínimos', 'Minimum full bathrooms')}<input type="number" min="1" max="100" value={criteria.minFullBathrooms ?? ''} placeholder={t('Sin mínimo', 'No minimum')} onChange={e => edit('minFullBathrooms', e.target.value ? Number(e.target.value) : null)} /></label><label className="prime-checkbox"><input type="checkbox" checked={criteria.nfc} onChange={e => edit('nfc', e.target.checked)} />{t('Compatible con tarjeta Prime', 'Prime card compatible')}</label></div> : null}</fieldset></form> : null}
          <div className="prime-criteria-chips">{criteria.destination ? <span><MapPin size={12} />{criteria.destination}</span> : null}{criteria.checkIn ? <span>{criteria.checkIn}{criteria.checkOut ? " → " + criteria.checkOut : ""}</span> : null}{criteria.adults ? <span><Users size={12} />{criteria.adults} {t("adultos", "adults")}{criteria.children + criteria.infants ? " + " + (criteria.children + criteria.infants) + " " + t("menores", "children") : ""}</span> : null}{criteria.maxTotal ? <span>{money(criteria.maxTotal)} {t('máximo total', 'max total')}<button disabled={busy || planBusy} aria-label={t('Quitar presupuesto', 'Remove budget')} onClick={() => edit('maxTotal', null)}><X size={12} /></button></span> : null}{criteria.minBedrooms != null ? <span>{criteria.minBedrooms}+ {t('habitaciones', 'bedrooms')}<button disabled={busy || planBusy} aria-label={t('Quitar mínimo de habitaciones', 'Remove minimum bedrooms')} onClick={() => edit('minBedrooms', null)}><X size={12} /></button></span> : null}{criteria.minFullBathrooms != null ? <span>{criteria.minFullBathrooms}+ {t('baños completos', 'full bathrooms')}<button disabled={busy || planBusy} aria-label={t('Quitar mínimo de baños', 'Remove minimum bathrooms')} onClick={() => edit('minFullBathrooms', null)}><X size={12} /></button></span> : null}{criteria.nfc ? <span>NFC<Check size={13} /></span> : null}{criteria.preferences.map(p => <span key={p}>{preferenceNames[p] || p}<button disabled={busy || planBusy} aria-label={t('Quitar', 'Remove') + ' ' + p} onClick={() => edit('preferences', criteria.preferences.filter(x => x !== p))}><X size={12} /></button></span>)}{criteria.unsupported.map(p => <span key={p} className="prime-unverified">{p}<button disabled={busy || planBusy} aria-label={t('Quitar requisito no verificable', 'Remove unverifiable requirement') + ' ' + p} onClick={() => edit('unsupported', criteria.unsupported.filter(x => x !== p))}><X size={12} /></button></span>)}</div>
        </section>
        {hasTripDetails ? <section className="prime-save-trip">
          {!saveForm ? <button className="prime-save-button" disabled={busy || planBusy} onClick={() => { setSaveForm(true); setPlanError(''); if (!planTitle) setPlanTitle((criteria.destination || t('Mi próximo viaje', 'My next trip')).slice(0, 80)); }}><CalendarDays size={16} />{activePlanId ? t('Guardar cambios del viaje', 'Save trip changes') : t('Guardar viaje', 'Save trip')}</button> : <form onSubmit={saveTrip}><label htmlFor="prime-plan-title">{t('Nombre de tu viaje', 'Trip name')}</label><input id="prime-plan-title" value={planTitle} onChange={e => setPlanTitle(e.target.value)} maxLength={80} required disabled={planBusy} /><div><button className="prime-primary" type="submit" disabled={planBusy || busy || !planTitle.trim()}>{planBusy ? t('Guardando…', 'Saving…') : t('Guardar en Mis viajes', 'Save to My trips')}</button><button type="button" disabled={planBusy} onClick={() => setSaveForm(false)}>{t('Cancelar', 'Cancel')}</button></div><p>{t('Guardaremos tus requisitos para retomarlos después. El precio y la disponibilidad se consultan al volver a abrir el plan.', 'We’ll save your requirements so you can return later. Price and availability are checked again when you reopen the plan.')}</p></form>}
          {planNotice ? <p role="status">{t('Guardado en Mis viajes. Es un plan, todavía no una reservación.', 'Saved to My trips. This is a plan, not a reservation yet.')}</p> : null}
          {planError ? <p className="prime-error" role="alert">{planErrorText}</p> : null}
        </section> : null}
        {error ? <p className="prime-error" role="alert">{error}</p> : null}
        {answer?.results.length ? <section className="prime-results">{answer.results.map(result => <article className="prime-property" key={result.property.id}><div className="prime-property-photo">{result.property.photos[0] ? <img src={result.property.photos[0]} alt={result.property.name} /> : <div className="prime-photo-placeholder"><MapPin size={40} /><span>{t('Propiedad de prueba', 'Test property')}</span></div>}<span className="prime-property-tag">✦ PRIME · DEMO</span></div><div className="prime-property-info"><span className="prime-location"><MapPin size={13} />{result.property.location || 'Puerto Rico'}</span><h3>{result.property.name}</h3><p>{criteria.checkIn} — {criteria.checkOut} · {result.quote.nights} {t('noches', 'nights')}</p><div className="prime-property-features"><span><Users size={15} />{t('Hasta', 'Up to')} {result.property.maxGuests}</span>{result.property.nfcVerified ? <span><CreditCard size={15} />NFC {t('probada', 'tested')}</span> : null}</div><div className="prime-property-price"><div><strong>{money(result.quote.totalAmount)}</strong><small>USD · {t('total con cargos e impuestos', 'total with fees and taxes')}</small></div><button className="prime-primary" onClick={() => setDetail(result)}>{t('Ver estancia', 'View stay')}<ArrowRight size={16} /></button></div><p className="prime-price-note">{t('Cotización de prueba. No retiene disponibilidad.', 'Test quote. Availability is not held.')}</p></div></article>)}</section> : null}
        {!turns.length && !busy ? <div className="prime-bottom-grid"><section className="prime-membership-banner"><span className="prime-eyebrow">{t('UNA MEMBRESÍA. TU FORMA DE VIAJAR.', 'ONE MEMBERSHIP. YOUR WAY TO TRAVEL.')}</span><h2>{t('Tu membresía', 'Your membership')}<br />{t('viaja contigo.', 'travels with you.')}</h2><p>{t('Descubre el concepto de tu tarjeta personal y el acceso por estancia que ya probamos.', 'Explore your personal card concept and the stay-based access we have already tested.')}</p><button onClick={() => setPage('card')}>{t('Conocer mi tarjeta', 'Explore my card')}<ArrowRight size={17} /></button><div className="prime-mini-card" aria-hidden="true"><span>Pin&Go <b>prime</b></span><Wifi size={25} /><small>FREDDIE · PILOT</small></div></section><section className="prime-pilot-info"><span className="prime-soft-icon"><ShieldCheck size={23} /></span><h3>{t('Un comienzo, bien conectado.', 'A connected beginning.')}</h3><p>{t('Este espacio privado permite probar la experiencia Prime con una propiedad Demo y consultas reales a su calendario y tarifas.', 'This private space lets you test the Prime experience with one Demo property and live calendar and rate queries.')}</p><span>{t('Sin descuentos ni reservas activados', 'Discounts and bookings are not enabled')}</span></section></div> : null}
      </> : page === 'card' ? <section className="prime-card-page"><span className="prime-eyebrow">PIN&GO PRIME</span><h1>{t('Una tarjeta.', 'One card.')}<br /><em>{t('Muchos próximos destinos.', 'Many destinations ahead.')}</em></h1><p>{t('Tu tarjeta personal es parte de la visión Prime. El acceso temporal fue probado físicamente en la cerradura Demo.', 'Your personal card is part of the Prime vision. Time-limited access was physically tested on the Demo lock.')}</p><div className="prime-member-card"><span>Pin&Go <b>prime</b></span><Wifi size={40} /><div><small>{t('MIEMBRO DE PRUEBA', 'PILOT MEMBER')}</small><strong>Freddie</strong></div></div><div className="prime-card-status"><ShieldCheck /><div><h3>{t('Prueba NFC superada', 'NFC test passed')}</h3><p>{t('Apertura y vencimiento confirmados. No tienes permisos de acceso activos desde Prime.', 'Unlocking and expiry confirmed. You have no active Prime access permissions.')}</p></div></div><p className="prime-muted">{t('Esta tarjeta visual es una representación. El vínculo permanente con la cuenta y la activación automática por reserva son la siguiente etapa.', 'This visual card is a representation. Permanent account linking and automatic activation per booking are the next stage.')}</p></section> : <section className="prime-trips-page"><span className="prime-eyebrow">{t('MIS VIAJES', 'MY TRIPS')}</span><h1>{t('Tus próximas escapadas.', 'Your next getaways.')}</h1><p>{t('Guarda una idea y retómala cuando quieras. Al abrirla, Pin AI vuelve a consultar opciones para tus requisitos.', 'Save an idea and return whenever you like. When you open it, Pin AI checks options for your requirements again.')}</p>
        <div className="prime-section-head"><h2>{t('Planes guardados', 'Saved plans')}</h2><span className="prime-pilot-badge">{t('En planificación', 'Planning')}</span></div>
        {plansLoading ? <p role="status">{t('Cargando tus planes…', 'Loading your plans…')}</p> : planError ? <p className="prime-error" role="alert">{planErrorText}</p> : null}
        {!plansLoading && !planError && !savedTrips.length ? <div className="prime-empty"><CalendarDays size={44} /><h2>{t('Tu próxima historia empieza aquí.', 'Your next story starts here.')}</h2><p>{t('Todavía no tienes planes guardados. Conversa con Pin AI y pulsa Guardar viaje para retomarlo después.', 'You have no saved plans yet. Chat with Pin AI and select Save trip to return to it later.')}</p><button className="prime-primary" onClick={() => setPage('explore')}>{t('Explorar con Pin AI', 'Explore with Pin AI')}<ArrowRight size={17} /></button></div> : null}
        {!plansLoading ? <div className="prime-saved-plans">{savedTrips.map(plan => <article className="prime-saved-plan" key={plan.id}><span className="prime-eyebrow">{t('PLAN DE VIAJE', 'TRIP PLAN')}</span><h3>{plan.title}</h3><p><MapPin size={14} />{plan.criteria.destination || t('Destino por decidir', 'Destination to decide')}</p><p>{plan.criteria.checkIn || t('Entrada por decidir', 'Check-in to decide')} → {plan.criteria.checkOut || t('Salida por decidir', 'Check-out to decide')}</p><p>{plan.criteria.adults ? plan.criteria.adults + ' ' + t('adultos', 'adults') : t('Viajeros por decidir', 'Travelers to decide')}{plan.criteria.children + plan.criteria.infants ? ' + ' + (plan.criteria.children + plan.criteria.infants) + ' ' + t('menores', 'children') : ''}{plan.criteria.maxTotal ? ' · ' + money(plan.criteria.maxTotal) + ' ' + t('máximo total', 'max total') : ''}</p><div className="prime-criteria-chips">{plan.criteria.minBedrooms != null ? <span>{plan.criteria.minBedrooms}+ {t('habitaciones', 'bedrooms')}</span> : null}{plan.criteria.minFullBathrooms != null ? <span>{plan.criteria.minFullBathrooms}+ {t('baños completos', 'full bathrooms')}</span> : null}{plan.criteria.nfc ? <span>NFC</span> : null}{plan.criteria.preferences.map(p => <span key={p}>{preferenceNames[p] || p}</span>)}{plan.criteria.unsupported.map(p => <span key={p} className="prime-unverified">{p}</span>)}</div><small>{t('Sin reservación ni precio retenido', 'No reservation or held price')}</small><div className="prime-plan-actions"><button className="prime-primary" disabled={busy || planBusy} onClick={() => resumeTrip(plan)}>{t('Retomar viaje', 'Resume trip')}<ArrowRight size={16} /></button>{deletePlanId === plan.id ? <><button disabled={planBusy} onClick={() => void deleteTrip(plan)}>{t('Confirmar eliminación', 'Confirm removal')}</button><button disabled={planBusy} onClick={() => setDeletePlanId(null)}>{t('Cancelar', 'Cancel')}</button></> : <button disabled={busy || planBusy} aria-label={t('Eliminar plan ', 'Remove plan ') + plan.title} onClick={() => setDeletePlanId(plan.id)}>{t('Eliminar', 'Remove')}</button>}</div></article>)}</div> : null}
        <p className="prime-plans-note">{t('Los planes guardados son ideas de viaje. Las reservaciones confirmadas se conectarán al implementar la cuenta permanente de Prime.', 'Saved plans are travel ideas. Confirmed reservations will connect when permanent Prime accounts are implemented.')}</p>
      </section>}

      <footer className="prime-footer"><span>Pin&Go Prime</span><span>{t('Piloto privado · Reservas y cobros no habilitados', 'Private pilot · Bookings and payments not enabled')}</span></footer>
    </main></div>
    <dialog ref={dialogRef} className="prime-detail-dialog" onCancel={() => setDetail(null)} onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>{detail ? <div><button className="prime-close" onClick={() => setDetail(null)} aria-label={t('Cerrar', 'Close')}><X /></button><span className="prime-eyebrow">PRIME · DEMO</span><h2>{detail.property.name}</h2><p>{criteria.checkIn} — {criteria.checkOut} · {detail.quote.nights} {t('noches', 'nights')}</p><dl>{[[t('Alojamiento', 'Accommodation'), detail.quote.nightlySubtotal], [t('Limpieza', 'Cleaning'), detail.quote.cleaningFee], [t('Cargos obligatorios', 'Mandatory charges'), detail.quote.amenitiesTotal], [t('Impuestos', 'Taxes'), detail.quote.taxesTotal], [t('Total · USD', 'Total · USD'), detail.quote.totalAmount]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{money(Number(value))}</dd></div>)}</dl><ListingDetails property={detail.property} lang={lang} />{detail.property.minimumAge ? <p>{t('Edad mínima del titular: ', 'Minimum booking age: ')}{detail.property.minimumAge}.</p> : null}<p>{t('Consulta realizada: ', 'Checked: ')}{new Date(detail.checkedAt).toLocaleString(lang === 'es' ? 'es-PR' : 'en-US', { timeZone: 'America/Puerto_Rico' })} (PR)</p><div className="prime-detail-note"><ShieldCheck size={18} /><p>{t('Precio y disponibilidad consultados en el sistema. Este piloto no crea reservas, cobra pagos ni activa cerraduras. Los beneficios comerciales aún no están definidos.', 'Price and availability checked in the system. This pilot does not create bookings, take payments, or activate locks. Commercial benefits have not been defined yet.')}</p></div><button className="prime-primary" onClick={() => setDetail(null)}>{t('Seguir explorando', 'Keep exploring')}</button></div> : null}</dialog>
  </div>;
}
function Brand() { return <div className="prime-brand"><span className="prime-brand-mark"><MapPin size={23} strokeWidth={2.5} /></span><span>Pin&Go<small>prime</small></span></div>; }

function ListingDetails({ property, lang }: { property: Result['property']; lang: 'es' | 'en' }) {
  const d = property.details;
  const es = lang === 'es';
  const bedNames: Record<string, [string, string]> = { KING: ['King', 'King'], QUEEN: ['Queen', 'Queen'], DOUBLE: ['Doble', 'Double'], SINGLE: ['Individual', 'Single'], BUNK: ['Litera', 'Bunk'], SOFA_BED: ['Sofá cama', 'Sofa bed'], FUTON: ['Futón', 'Futon'], CRIB: ['Cuna', 'Crib'], OTHER: ['Otra', 'Other'] };
  return <section className="prime-listing-facts"><h3>{es ? 'Lo que publica el anfitrión' : 'From the host’s listing'}</h3>
    <div className="prime-criteria-chips">{property.features.map(feature => <span key={feature}>{preferenceLabels[feature as keyof typeof preferenceLabels]?.[es ? 0 : 1] || feature}</span>)}</div>
    {d ? <>
      <div className="prime-space-facts">
        <p><strong>{d.bedrooms ?? (es ? 'Sin indicar' : 'Not listed')}</strong> {es ? 'habitaciones' : 'bedrooms'}</p>
        <p><strong>{d.fullBathrooms ?? (es ? 'Sin indicar' : 'Not listed')}</strong> {es ? 'baños completos' : 'full bathrooms'}</p>
        {d.halfBathrooms != null ? <p><strong>{d.halfBathrooms}</strong> {es ? 'medios baños' : 'half bathrooms'}</p> : null}
      </div>
      {d.beds.length ? <p>{es ? 'Camas publicadas: ' : 'Listed beds: '}{d.beds.map(b => b.quantity + ' ' + (bedNames[b.type]?.[es ? 0 : 1] || b.type)).join(' · ')}</p> : null}
      {property.features.includes('pool') ? <p>{d.poolPrivacy === 'PRIVATE' ? (es ? 'Piscina publicada como privada.' : 'Pool listed as private.') : d.poolPrivacy === 'SHARED' ? (es ? 'La piscina es un espacio compartido.' : 'The pool is a shared space.') : (es ? 'La privacidad de la piscina no está confirmada.' : 'Pool privacy is not confirmed.')}</p> : null}
      {property.features.includes('parking') ? <p>{es ? 'Estacionamiento: ' : 'Parking: '}{d.parkingFeeType === 'FREE' ? (es ? 'gratuito según el anuncio.' : 'free according to the listing.') : d.parkingFeeType === 'PAID' ? (es ? 'de pago; confirma el cargo antes de reservar.' : 'paid; confirm the fee before booking.') : (es ? 'el anuncio no confirma si tiene costo.' : 'the listing does not confirm any fees.')}</p> : null}
      {d.hostReportedNearbyPlaces.length ? <div className="prime-nearby"><h4>{es ? 'Cerca, según el anfitrión' : 'Nearby, according to the host'}</h4><ul>{d.hostReportedNearbyPlaces.map((place, index) => <li key={index}><strong>{es ? place.nameEs || place.name : place.name}</strong>{place.distanceText ? <span>{place.distanceText}</span> : null}{place.travelTimeMinutes != null ? <span>{place.travelTimeMinutes} min · {es ? 'medio de transporte sin especificar' : 'travel mode not specified'}</span> : null}</li>)}</ul><p>{es ? 'Distancias y tiempos publicados por el anfitrión. Pin AI no ha comprobado las rutas.' : 'Distances and times provided by the host. Pin AI has not verified routes.'}</p></div> : null}
    </> : null}
  </section>;
}
