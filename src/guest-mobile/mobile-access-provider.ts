export type MobileAccessProviderIssueInput = Readonly<{
  providerLockId: number;
  recipient: string;
  startsAt: Date;
  endsAt: Date;
}>;

export type MobileAccessProviderCredential = Readonly<{
  providerKeyId: string;
  lockData: string;
  lockMac: string;
  startsAt: Date;
  endsAt: Date;
}>;

export interface MobileAccessProvider {
  issueTimeboundKey(input: MobileAccessProviderIssueInput): Promise<MobileAccessProviderCredential>;
  revokeKey(input: Readonly<{ providerKeyId: string; providerLockId: number }>): Promise<void>;
}
