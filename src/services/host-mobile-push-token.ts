import {createDecipheriv, createHash, timingSafeEqual} from 'node:crypto';

export const HOST_PUSH_PROJECT = 'f7037a5c-4526-46d7-b7bb-fb56e2be2f8f';
export type HostPushEnvironment = Readonly<Record<string, string | undefined>>;
export type EncryptedHostPushDevice = {
  organizationId: string; userId: string; sessionId: string; tokenHash: string;
  tokenCiphertext: string; projectId: string; platform: string;
};

// No raw crypto/JSON/provider error is propagated: it may contain token material.
// Old key IDs remain readable while registration writes with the active key ID.
export function decryptHostPushToken(device: EncryptedHostPushDevice, env: HostPushEnvironment): string {
  try {
    if (device.projectId !== HOST_PUSH_PROJECT || !['ios', 'android'].includes(device.platform) ||
        !/^[a-f0-9]{64}$/.test(device.tokenHash) || device.tokenCiphertext.length > 2048) throw Error();
    const envelope = JSON.parse(device.tokenCiphertext);
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'data,iv,keyId,tag,version' ||
        envelope.version !== 1 || typeof envelope.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(envelope.keyId) ||
        typeof envelope.iv !== 'string' || !/^[a-f0-9]{24}$/.test(envelope.iv) ||
        typeof envelope.tag !== 'string' || !/^[a-f0-9]{32}$/.test(envelope.tag) ||
        typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw Error();
    const ring = JSON.parse(env.HOST_MOBILE_PUSH_TOKEN_KEYS ?? '{}');
    const key = Object.hasOwn(ring, envelope.keyId) ? ring[envelope.keyId] : null;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(JSON.stringify([device.organizationId, device.userId, device.sessionId, device.tokenHash])));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const token = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
    if (!/^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{16,200}\]$/.test(token) ||
        !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(device.tokenHash, 'hex'))) throw Error();
    return token;
  } catch {
    throw Error('HOST_PUSH_TOKEN_UNAVAILABLE');
  }
}
