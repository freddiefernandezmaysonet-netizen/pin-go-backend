import axios from "axios";
import type { PrismaClient } from "@prisma/client";
import { decryptMobileAccessSecret } from "./mobile-access-crypto.service.js";
import { getOrgTtlockAccessToken } from "../services/ttlock/ttlock.org-auth.js";
import type { MobileAccessProvider, MobileAccessProviderCredential, MobileAccessProviderIssueInput } from "./mobile-access-provider.js";

const BASE_URL = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

function clientId() {
  const value = String(process.env.TTLOCK_CLIENT_ID ?? "").trim();
  if (!value) throw new Error("TTLOCK_CLIENT_ID_MISSING");
  return value;
}

function identityAad(id: string, kind: "access-token") {
  return `mobile-access:ttlock-recipient:v1:${id}:${kind}`;
}

export class TTLockMobileAccessProvider implements MobileAccessProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly organizationId: string,
    private readonly recipientIdentityId: string,
  ) {}

  async issueTimeboundKey(input: MobileAccessProviderIssueInput): Promise<MobileAccessProviderCredential> {
    const identity = await this.prisma.tTLockRecipientIdentity.findUnique({ where: { id: this.recipientIdentityId } });
    if (
      !identity ||
      identity.status !== "ACTIVE" ||
      identity.username !== input.recipient ||
      !identity.accessTokenCiphertext ||
      !identity.tokenKeyVersion
    ) throw new Error("TTLOCK_RECIPIENT_NOT_READY");

    const ownerAccessToken = await getOrgTtlockAccessToken(this.prisma, this.organizationId);
    const send = await axios.post(`${BASE_URL}/v3/key/send`, null, {
      params: {
        clientId: clientId(),
        accessToken: ownerAccessToken,
        lockId: input.providerLockId,
        receiverUsername: identity.username,
        keyName: "Pin&Go Guest",
        startDate: input.startsAt.getTime(),
        endDate: input.endsAt.getTime(),
        remoteEnable: 2,
        createUser: 0,
        date: Date.now(),
      },
      timeout: 15000,
    });

    const providerKeyId = String(send.data?.keyId ?? "");
    if (!providerKeyId) throw new Error("TTLOCK_EKEY_SEND_INCOMPLETE");

    const recipientAccessToken = decryptMobileAccessSecret(
      identity.accessTokenCiphertext,
      identity.tokenKeyVersion,
      identityAad(identity.id, "access-token"),
    );

    const detail = await axios.get(`${BASE_URL}/v3/key/get`, {
      params: {
        clientId: clientId(),
        accessToken: recipientAccessToken,
        keyId: providerKeyId,
        date: Date.now(),
      },
      timeout: 15000,
    });

    const lockData = String(detail.data?.lockData ?? "");
    const lockMac = String(detail.data?.lockMac ?? "");
    const startsAt = new Date(Number(detail.data?.startDate));
    const endsAt = new Date(Number(detail.data?.endDate));
    if (!lockData || !lockMac || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
      throw new Error("TTLOCK_EKEY_DETAIL_INCOMPLETE");
    }

    return { providerKeyId, lockData, lockMac, startsAt, endsAt };
  }

  async revokeKey(input: Readonly<{ providerKeyId: string; providerLockId: number }>) {
    const ownerAccessToken = await getOrgTtlockAccessToken(this.prisma, this.organizationId);
    await axios.post(`${BASE_URL}/v3/key/delete`, null, {
      params: {
        clientId: clientId(),
        accessToken: ownerAccessToken,
        keyId: input.providerKeyId,
        date: Date.now(),
      },
      timeout: 15000,
    });
  }
}
