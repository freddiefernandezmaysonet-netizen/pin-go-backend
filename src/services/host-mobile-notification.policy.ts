// Pure preparation policy only. No registration, provider call or notification is performed here.
export type HostAttentionKind = 'NEW_RESERVATION' | 'GUEST_INCIDENT' | 'GUEST_MESSAGE' | 'CLEANING_EXCEPTION' | 'ACCESS_EXCEPTION';
export type HostAttentionEvent = {
  id: string; organizationId: string; propertyId: string; kind: HostAttentionKind;
  actionRequired: boolean; state: 'INFORMATIONAL' | 'ACTION_REQUIRED' | 'WAITING' | 'AUTO_RESOLVING' | 'RESOLVED';
  severity: 'INFO' | 'WARNING' | 'CRITICAL'; occurredAt: Date;
};
export type HostPushPreference = {
  enabled: boolean; kinds: readonly HostAttentionKind[]; timezone: string;
  quietHours: { startHour: number; endHour: number; allowCritical: boolean } | null;
};
export type HostPushRecipient = { userId: string; organizationId: string; role: string; activeSession: boolean; allowedPropertyIds: readonly string[] };
type Target = 'reservation' | 'incidents' | 'messages' | 'cleanings' | 'access';
const targets: Record<HostAttentionKind, Target> = { NEW_RESERVATION: 'reservation', GUEST_INCIDENT: 'incidents', GUEST_MESSAGE: 'messages', CLEANING_EXCEPTION: 'cleanings', ACCESS_EXCEPTION: 'access' };
const titles: Record<HostAttentionKind, string> = { NEW_RESERVATION: 'New reservation', GUEST_INCIDENT: 'Guest incident needs attention', GUEST_MESSAGE: 'Guest message needs attention', CLEANING_EXCEPTION: 'Cleaning needs attention', ACCESS_EXCEPTION: 'Access needs attention' };
const validId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
export function prepareHostAttentionNotification(event: HostAttentionEvent, recipient: HostPushRecipient, preference: HostPushPreference, now: Date) {
  const skip = (reason: string) => ({ status: 'SKIP' as const, reason });
  if (![event.id,event.organizationId,event.propertyId,recipient.userId,recipient.organizationId].every(validId) ||
      !Object.hasOwn(targets,event.kind) || !['INFO','WARNING','CRITICAL'].includes(event.severity) ||
      !Number.isFinite(event.occurredAt.getTime()) || !Number.isFinite(now.getTime())) return skip('INVALID_INPUT');
  if (!recipient.activeSession || !['ORG_ADMIN','ADMIN','PLATFORM_ADMIN'].includes(recipient.role) ||
      recipient.organizationId !== event.organizationId || !recipient.allowedPropertyIds.includes(event.propertyId)) return skip('ACCESS_DENIED');
  if (!preference.enabled || !preference.kinds.includes(event.kind)) return skip('OPTED_OUT');
  if (event.kind === 'NEW_RESERVATION' ? event.state !== 'INFORMATIONAL' : !event.actionRequired || event.state !== 'ACTION_REQUIRED') return skip('NO_HOST_ACTION');
  // A stale or future signal must be re-evaluated from authoritative state, never blindly delivered.
  const age = now.getTime() - event.occurredAt.getTime();
  if (age < 0 || age > 24 * 60 * 60_000) return skip('STALE_SIGNAL');
  let hour: number;
  try { hour = Number(new Intl.DateTimeFormat('en-US',{timeZone:preference.timezone,hour:'numeric',hourCycle:'h23'}).format(now)); }
  catch { return skip('INVALID_TIMEZONE'); }
  const quiet = preference.quietHours;
  if (quiet) {
    if (![quiet.startHour,quiet.endHour].every(h=>Number.isInteger(h)&&h>=0&&h<=23) || quiet.startHour === quiet.endHour) return skip('INVALID_QUIET_HOURS');
    const inside = quiet.startHour < quiet.endHour ? hour >= quiet.startHour && hour < quiet.endHour : hour >= quiet.startHour || hour < quiet.endHour;
    if (inside && !(quiet.allowCritical && event.severity === 'CRITICAL')) return { status:'DEFER' as const, reason:'QUIET_HOURS' };
  }
  // Dedupe must be enforced by durable storage at dispatch; this key alone does not send or deduplicate.
  const deduplicationKey = [event.organizationId,recipient.userId,event.id].map(v=>`${v.length}_${v}`).join('.');
  return { status:'PREPARED' as const, deduplicationKey,
    payload: { title:titles[event.kind], body:'Open Pin&Go Host to review the latest status.',
      data:{ version:1, eventId:event.id, organizationId:event.organizationId, propertyId:event.propertyId, target:targets[event.kind] } } };
}
