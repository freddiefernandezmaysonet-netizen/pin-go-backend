import type {prepareHostAttentionNotification} from './host-mobile-notification.policy.js';

type Prepared = Extract<ReturnType<typeof prepareHostAttentionNotification>, {status: 'PREPARED'}>;
export type PushSendResult =
  | {state: 'ACCEPTED'; ticketId: string}
  | {state: 'RETRY'; code: 'RATE_LIMITED'}
  | {state: 'FAILED'; code: 'DEVICE_NOT_REGISTERED' | 'PROVIDER_REJECTED'}
  | {state: 'UNKNOWN'; code: 'SEND_OUTCOME_UNKNOWN'};
export type PushReceiptResult =
  | {state: 'PROVIDER_ACCEPTED'}
  | {state: 'PENDING'}
  | {state: 'FAILED'; code: 'DEVICE_NOT_REGISTERED' | 'PROVIDER_REJECTED'};
export type HostPushProvider = {
  send(token: string, payload: Prepared['payload'], expiresAt: Date): Promise<PushSendResult>;
  receipt(ticketId: string): Promise<PushReceiptResult>;
};
const validTicket = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const failure = (value: unknown): 'DEVICE_NOT_REGISTERED' | 'PROVIDER_REJECTED' =>
  value === 'DeviceNotRegistered' ? 'DEVICE_NOT_REGISTERED' : 'PROVIDER_REJECTED';

// A single message per request makes ticket-to-device correlation exact. No SDK
// retries: an ambiguous send must never be replayed by a hidden transport layer.
export function createExpoHostPushProvider(accessToken: string, fetcher: typeof fetch = fetch): HostPushProvider {
  if (!/^[A-Za-z0-9._~-]{16,500}$/.test(accessToken)) throw Error('HOST_PUSH_PROVIDER_UNAVAILABLE');
  async function request(path: 'send' | 'getReceipts', body: unknown) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Includes JSON parsing; adapters ignoring AbortSignal still cannot hang the cycle.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Error('TIMEOUT')); }, 10_000);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetcher(`https://exp.host/--/api/v2/push/${path}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}`},
          body: JSON.stringify(body),
        });
        // Provider error text is deliberately never returned or logged.
        if (response.status === 429) return {status: 429, value: null};
        if (!response.ok) return {status: response.status, value: null};
        return {status: response.status, value: await response.json() as Record<string, unknown>};
      })()]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async send(token, payload, expiresAt) {
      try {
        const {status, value} = await request('send', [{to: token, ...payload,
          channelId: 'host-operations', sound: 'default', expiration: Math.floor(expiresAt.getTime() / 1000)}]);
        if (status === 429) return {state: 'RETRY', code: 'RATE_LIMITED'};
        if (status >= 400 && status < 500) return {state: 'FAILED', code: 'PROVIDER_REJECTED'};
        if (status !== 200 || !value || value.errors !== undefined || !Array.isArray(value.data) || value.data.length !== 1)
          return {state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'};
        const ticket = value.data[0];
        if (ticket?.status === 'ok' && validTicket(ticket.id)) return {state: 'ACCEPTED', ticketId: ticket.id};
        if (ticket?.status === 'error') {
          if (ticket.details?.error === 'MessageRateExceeded') return {state: 'RETRY', code: 'RATE_LIMITED'};
          return {state: 'FAILED', code: failure(ticket.details?.error)};
        }
      } catch { /* Sending may already have happened. */ }
      return {state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'};
    },
    async receipt(ticketId) {
      if (!validTicket(ticketId)) return {state: 'FAILED', code: 'PROVIDER_REJECTED'};
      try {
        const {status, value} = await request('getReceipts', {ids: [ticketId]});
        if (status !== 200 || !value || value.errors !== undefined || !value.data || typeof value.data !== 'object' || Array.isArray(value.data))
          return {state: 'PENDING'};
        const data = value.data as Record<string, {status?: string; details?: {error?: string}}>;
        const receipt = Object.hasOwn(data, ticketId) ? data[ticketId] : null;
        if (receipt?.status === 'ok') return {state: 'PROVIDER_ACCEPTED'};
        if (receipt?.status === 'error') return {state: 'FAILED', code: failure(receipt.details?.error)};
      } catch { /* Receipt lookup is read-only and can be retried. */ }
      return {state: 'PENDING'};
    },
  };
}
