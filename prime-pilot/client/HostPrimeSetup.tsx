import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check, ShieldCheck } from 'lucide-react';
import type { PilotEnrollment } from '../enrollment';
import { isPrimeNightlyDiscount, PRIME_MIN_NIGHTLY_DISCOUNT, PRIME_MAX_NIGHTLY_DISCOUNT } from '../enrollment-policy';

type Props = {
  language: 'es' | 'en';
  request: (path: string, method?: string, body?: unknown) => Promise<{ enrollment: PilotEnrollment }>;
  onUpdated: () => void;
};
export function HostPrimeSetup({ language, request, onUpdated }: Props) {
  const t = (es: string, en: string) => language === 'es' ? es : en;
  const [saved, setSaved] = useState<PilotEnrollment | null>(null);
  const [draft, setDraft] = useState<Pick<PilotEnrollment, 'participation' | 'benefitDraft'> | null>(null);
  const [discountText, setDiscountText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(false);
  const [reload, setReload] = useState(0);
  const discount = discountText.trim() === '' ? null : Number(discountText);
  const validDiscount = isPrimeNightlyDiscount(discount);
  const needsDiscount = draft?.participation === 'ACTIVE' && !validDiscount;
  const legacyDiscountNeedsReview = saved?.version === 1 && !isPrimeNightlyDiscount(saved.benefitDraft.nightlyDiscountPercent);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setAcknowledged(false); setNotice(false);
    request('pilot/enrollment').then(data => { if (active) { setSaved(data.enrollment); setDraft(data.enrollment); setDiscountText(data.enrollment.benefitDraft.nightlyDiscountPercent?.toString() ?? ''); } }).catch(() => { if (active) setError('LOAD'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, reload]);
  function editBenefits<K extends Exclude<keyof PilotEnrollment['benefitDraft'], 'nightlyDiscountPercent'>>(key: K, value: PilotEnrollment['benefitDraft'][K]) {
    setDraft(previous => previous ? { ...previous, benefitDraft: { ...previous.benefitDraft, [key]: value } } : previous);
    setNotice(false); setAcknowledged(false);
  }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!draft || !saved || !acknowledged || saving || needsDiscount || error === 'ENROLLMENT_CHANGED') return;
    setSaving(true); setError(''); setNotice(false);
    try {
      const data = await request('pilot/enrollment', 'PUT', { participation: draft.participation, benefitDraft: { ...draft.benefitDraft, nightlyDiscountPercent: validDiscount ? discount : null }, expectedRevision: saved.revision, confirmPilotOnly: true });
      setSaved(data.enrollment); setDraft(data.enrollment); setDiscountText(data.enrollment.benefitDraft.nightlyDiscountPercent?.toString() ?? ''); setAcknowledged(false); setNotice(true); onUpdated();
    } catch (e) { setError(e instanceof Error ? e.message : 'SAVE'); }
    finally { setSaving(false); }
  }
  return <section className="prime-host-page"><span className="prime-eyebrow">{t('ANFITRIÓN · DEMO', 'HOST · DEMO')}</span><h1>{t('Tu propiedad en Prime.', 'Your property on Prime.')}</h1><p>{t('Prueba cómo participará una propiedad y prepara los beneficios que te gustaría ofrecer a los miembros.', 'Test how a property participates and prepare the benefits you would like to offer members.')}</p>
    <div className="prime-host-scope"><ShieldCheck size={21} /><p>{t('Configuración exclusiva de Pin&Go Demo Property en este piloto. Los beneficios se guardan como borrador; las tarifas, cobros y accesos continúan funcionando como hasta ahora.', 'Configuration is limited to Pin&Go Demo Property in this pilot. Benefits are saved as a draft; rates, payments and access continue working as before.')}</p></div>
    {loading ? <p role="status">{t('Cargando configuración…', 'Loading configuration…')}</p> : null}
    {error ? <div className="prime-error" role="alert"><p>{error === 'ENROLLMENT_CHANGED' ? t('La configuración cambió desde que abriste esta pantalla. Recárgala y revisa los valores antes de guardar.', 'The configuration changed after you opened this screen. Reload it and review the values before saving.') : t('No pudimos completar la operación. Recarga la configuración para intentarlo de nuevo.', 'We couldn’t complete the operation. Reload the configuration and try again.')}</p><button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>{t('Recargar configuración', 'Reload configuration')}</button></div> : null}
    {!loading && draft && saved && error !== 'LOAD' ? <form onSubmit={save} noValidate><fieldset disabled={saving || error === 'ENROLLMENT_CHANGED'} className="prime-host-fieldset">
      <section className="prime-host-panel"><div className="prime-host-property"><Building2 size={26} /><div><h2>Pin&Go Demo Property</h2><span>{saved.participation === 'ACTIVE' ? t('Activa en el buscador piloto', 'Active in the pilot search') : t('Pausada en el buscador piloto', 'Paused in the pilot search')}</span></div></div><label htmlFor="prime-participation">{t('Participación en el buscador', 'Search participation')}</label><select id="prime-participation" value={draft.participation} onChange={e => { setDraft({ ...draft, participation: e.target.value as PilotEnrollment['participation'] }); setAcknowledged(false); setNotice(false); }}><option value="ACTIVE">{t('Activa', 'Active')}</option><option value="PAUSED">{t('Pausada', 'Paused')}</option></select><p>{t('Al pausar Demo, deja de aparecer en nuevas consultas de Prime. Los planes guardados conservan sus requisitos para retomarlos después.', 'Pausing Demo removes it from new Prime searches. Saved plans keep their requirements so they can be resumed later.')}</p></section>
      <section className="prime-host-panel"><div className="prime-section-head"><h2>{t('Beneficios propuestos', 'Proposed benefits')}</h2><span className="prime-pilot-badge">{t('Borrador', 'Draft')}</span></div><p>{t('El descuento Prime es obligatorio para guardar una participación activa. En este piloto los beneficios siguen en borrador y todavía no se aplican a las cotizaciones.', 'A Prime discount is required to save active participation. Benefits remain drafts in this pilot and are not yet applied to quotes.')}</p><label htmlFor="prime-discount-draft">{t('Descuento Prime sobre las noches (%)', 'Prime discount on nightly charges (%)')}</label><input id="prime-discount-draft" type="number" min={PRIME_MIN_NIGHTLY_DISCOUNT} max={PRIME_MAX_NIGHTLY_DISCOUNT} step="any" required={draft.participation === 'ACTIVE'} disabled={draft.participation === 'PAUSED'} value={discountText} aria-invalid={needsDiscount || undefined} aria-describedby="prime-discount-hint prime-discount-state" onChange={e => { setDiscountText(e.target.value); setNotice(false); setAcknowledged(false); }} /><small id="prime-discount-hint">{t('Entre 5% y 20%, únicamente sobre el alojamiento por noche. Limpieza y otros cargos quedan fuera del descuento.', 'Between 5% and 20%, applied only to nightly accommodation. Cleaning and other charges are excluded.')}</small>
        <small id="prime-discount-state" role="status">{needsDiscount ? t('Selecciona un descuento válido para guardar Demo activa.', 'Choose a valid discount before saving Demo as active.') : draft.participation === 'PAUSED' && !validDiscount ? t('Al guardar Demo pausada, el descuento quedará pendiente de definir antes de reactivarla.', 'Saving Demo as paused will leave the discount unset until you choose it before reactivation.') : ''}</small>
        {legacyDiscountNeedsReview ? <p>{t('El borrador anterior no tenía un porcentaje dentro del rango Prime. Puedes elegirlo o pausar Demo; no asignaremos un descuento automáticamente.', 'The previous draft did not have a percentage within the Prime range. You can choose one or pause Demo; no discount will be assigned automatically.')}</p> : null}
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.earlyCheckInRequest} onChange={e => editBenefits('earlyCheckInRequest', e.target.checked)} /><span>{t('Solicitud de entrada temprana, sujeta a disponibilidad', 'Early check-in request, subject to availability')}</span></label>
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.lateCheckoutRequest} onChange={e => editBenefits('lateCheckoutRequest', e.target.checked)} /><span>{t('Solicitud de salida tardía, sujeta a disponibilidad', 'Late checkout request, subject to availability')}</span></label>
        <label className="prime-host-check"><input type="checkbox" checked={draft.benefitDraft.personalNfc} onChange={e => editBenefits('personalNfc', e.target.checked)} /><span>{t('Compatibilidad con tarjeta personal Prime', 'Personal Prime card compatibility')}</span></label>
      </section>
      <label className="prime-host-check prime-host-ack"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /><span>{t('Entiendo que estoy configurando solo Demo en el piloto y que los beneficios quedan en borrador.', 'I understand I am configuring only Demo in the pilot and benefits remain a draft.')}</span></label>
      <button className="prime-primary" disabled={!acknowledged || saving || needsDiscount || error === 'ENROLLMENT_CHANGED'} type="submit">{saving ? t('Guardando…', 'Saving…') : t('Guardar configuración de Demo', 'Save Demo configuration')}</button>
    </fieldset></form> : null}
    {notice ? <p className="prime-host-success" role="status"><Check size={17} />{t('Configuración guardada. La participación está actualizada; los beneficios siguen en borrador.', 'Configuration saved. Participation is updated; benefits remain a draft.')}</p> : null}
  </section>;
}
