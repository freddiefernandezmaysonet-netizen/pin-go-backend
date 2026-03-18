import { api } from "./client";

export type StaffMember = {
  id: string;
  organizationId: string;
  fullName: string;
  phoneE164: string | null;
  companyName: string | null;
  photoUrl: string | null;
  ttlockCardRef: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export function listStaff(organizationId: string) {
  return api<StaffMember[]>(`/staff?organizationId=${encodeURIComponent(organizationId)}`);
}

export function createStaff(input: {
  organizationId: string;
  fullName: string;
  phoneE164?: string;
  companyName?: string;
  photoUrl?: string;
  ttlockCardRef?: string;
}) {
  return api<StaffMember>("/staff", {
    method: "POST",
    body: JSON.stringify(input),
  });
}