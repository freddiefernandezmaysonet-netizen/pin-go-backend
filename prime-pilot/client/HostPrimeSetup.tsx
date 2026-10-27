import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check, ShieldCheck } from 'lucide-react';
import type { PilotEnrollment } from '../enrollment';

type Props = {
  language: 'es' | 'en';
  request: (path: string, method?: string, body?: unknown) => Promise<{ enrollment: PilotEnrollment }>;
  onUpdated: () => void;
};
export function HostPrimeSetup({ language, request, onUpdated }: Props) {
  const t = (es: string, en: string) => language === 'es' ? es : en;
  const [saved, setSaved] = useState<PilotEnrollment | null>(null);
  const [draft, setDraft] = useState<PilotEnrollment | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setAcknowledged(false); setNotice(false);
    request('pilot/enrollment').then(data => { if (active) { setSaved(data.enrollment); setDraft(data.enrollment); } }).catch(() => { if (active) setError('LOAD'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, reload]);
  function editBenefits<K extends keyof PilotEnrollment['benefitDraft']>(key: K, value: PilotEnrollment['benefitDraft'][K]) {
    setDraft(previous => previous ? { ...previous, benefitDraft: { ...previous.benefitDraft, [key]: value } } : previous);
    setNotice(false); setAcknowledged(false);
  }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!draft || !saved || !acknowledged || saving || error === 'ENROLLMENT_CHANGED') return;
    setSaving(true); setError(''); setNotice(false);
    try {
      const data = await request('pilot/enrollment', 'PUT', { participation: draft.participation, benefitDraft: draft.benefitDraft, expectedRevision: saved.revision, confirmPilotOnly: true });
      setSaved(data.enrollment); setDraft(data.enrollment); setAcknowledged(false); setNotice(true); onUpdated();
    } catch (e) { setError(e instanceof Error ? e.message : 'SAVE'); }
    finally { setSaving(false); }
  }
  return <section className="prime-host-page"><span className="prime-eyebrow">{t('ANFITRIÓN · DEMO', 'HOST · DEMO')}</span><h1>{t('Tu propiedad en Prime.', 'Your property on Prime.')}</h1><p>{t('Prueba cómo participará una propiedad y prepara los beneficios que te gustaría ofrecer a los miembros.', 'Test how a property participates and prepare the benefits you would like to offer members.')}</p>
    <div className="prime-host-scope"><ShieldCheck size={21} /><p>{t('Configuración exclusiva de Pin&Go Demo Property en este piloto. Los beneficios se guardan como borrador; las tarifas, cobros y accesos continúan funcionando como hasta ahora.', 'Configuration is limited to Pin&Go Demo Property in this pilot. Benefits are saved as a draft; rates, payments and access continue working as before.')}</p></div>
    {loading ? <p role="status">{t('Cargando configuración…', 'Loading configuration…')}</p> : null}
    {error ? <div className="prime-error" role="alert"><p>{error === 'ENROLLMENT_CHANGED' ? t('La configuración cambió desde que abriste esta pantalla. Recárgala y revisa los valores antes de guardar.', 'The configuration changed after you opened this screen. Reload it and review the values before saving.') : t('No pudimos completar la operación. Recarga la configuración para intentarlo de nuevo.', 'We couldn’t complete the operation. Reload the configuration and try again.')}</p><button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>{t('Recargar configuración', 'Reload configuration')}</button></div> : null}
    {!loading && draft && saved && error !== 'LOAD' ? <form onSubmit={save}><fieldset disabled={saving || error === 'ENROLLMENT_CHANGED'} className="prime-host-fieldset">
      <section className="prime-host-panel"><div className="prime-host-property"><Building2 size={26} /><div><h2>Pin&Go Demo Property</h2><span>{saved.participation === 'ACTIVE' ? t('Activa en el buscador piloto', 'Active in the pilot search') : t('Pausada en el buscador piloto', 'Paused in the pilot search')}</span></div></div><label htmlFor="prime-participation">{t('Participación en el buscador', 'Search participation')}</label><select id="prime-participation" value={draft.participation} onChange={e => { setDraft({ ...draft, participation: e.target.value as PilotEnrollment['participation'] }); setAcknowledged(false); setNotice(false); }}><option value="ACTIVE">{t('Activa', 'Active')}</option><option value="PAUSED">{t('Pausada', 'Paused')}</option></select><p>{t('Al pausar Demo, deja de aparecer en nuevas consultas de Prime. Los planes guardados conservan sus requisitos para retomarlos después.', 'Pausing Demo removes it from new Prime searches. Saved plans keep their requirements so they can be resumed later.')}</p></section>
      <section className="prime-host-panel"><div className="prime-section-head"><h2>{t('Beneficios propuestos', 'Proposed benefits')}</h2><span className="prime-pilot-badge">{t('Borrador', 'Draft')}</span></div><p>{t('Define una propuesta para revisarla. Estos beneficios todavía no se anuncian al huésped ni se aplican a sus cotizaciones.', 'Define a proposal to review. These benefits are not yet advertised to guests or applied to their quotes.')}</p><label htmlFor="prime-discount-draft">{t('Descuento propuesto sobre las noches (%)', 'Proposed discount on nightly charges (%)')}</label><input id="prime-discount-draft" type="number" min="0" max="100" step="1" required value={draft.benefitDraft.nightlyDiscountPercent} onChange={e => editBenefits('nightlyDiscountPercent', Number(e.target.value))} /><small>{t('0 significa sin descuento propuesto. Financiación y condiciones comerciales pendientes.', '0 means no proposed discount. Funding and commercial conditions remain to be defined.')}</small>
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.earlyCheckInRequest} onChange={e => editBenefits('earlyCheckInRequest', e.target.checked)} /><span>{t('Solicitud de entrada temprana, sujeta a disponibilidad', 'Early check-in request, subject to availability')}</span></label>
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.lateCheckoutRequest} onChange={e => editBenefits('lateCheckoutRequest', e.target.checked)} /><span>{t('Solicitud de salida tardía, sujeta a disponibilidad', 'Late checkout request, subject to availability')}</span></label>
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.personalNfc} onChange={e => editBenefits('personalNfc', e.target.checked)} /><span>{t('Compatibilidad con tarjeta personal Prime', 'Personal Prime card compatibility')}</span></label>
      </section>
      <label className="prime-host-check prime-host-ack"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /><span>{t('Entiendo que estoy configurando solo Demo en el piloto y que los beneficios quedan en borrador.', 'I understand I am configuring only Demo in the pilot and benefits remain a draft.')}</span></label>
      <button className="prime-primary" disabled={!acknowledged || saving || error === 'ENROLLMENT_CHANGED'} type="submit">{saving ? t('Guardando…', 'Saving…') : t('Guardar configuración de Demo', 'Save Demo configuration')}</button>
    </fieldset></form> : null}
    {notice ? <p className="prime-host-success" role="status"><Check size={17} />{t('Configuración guardada. La participación está actualizada; los beneficios siguen en borrador.', 'Configuration saved. Participation is updated; benefits remain a draft.')}</p> : null}
  </section>;
}
