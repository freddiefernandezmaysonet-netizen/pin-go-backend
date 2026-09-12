import { normalizeOtpDestination, type OtpFactorType } from "./mfa-otp.js";

export type EnrollmentFactor = {
  userId: string;
  type: OtpFactorType;
  destination: string;
  status: "PENDING" | "VERIFIED";
};

export function prepareEnrollment(params: {
  userId: string;
  accountEmail: string;
  type: OtpFactorType;
  destination?: string | null;
}): EnrollmentFactor {
  const userId = String(params.userId ?? "").trim();
  if (!userId) throw new Error("USER_ID_REQUIRED");

  if (params.type === "EMAIL") {
    const accountEmail = normalizeOtpDestination("EMAIL", params.accountEmail);
    const requested = normalizeOtpDestination("EMAIL", params.destination ?? params.accountEmail);
    if (requested !== accountEmail) throw new Error("EMAIL_MUST_MATCH_ACCOUNT");
    return { userId, type: "EMAIL", destination: accountEmail, status: "PENDING" };
  }

  if (!params.destination) throw new Error("SMS_DESTINATION_REQUIRED");
  return {
    userId,
    type: "SMS",
    destination: normalizeOtpDestination("SMS", params.destination),
    status: "PENDING",
  };
}

export function applyEnrollmentVerification(factor: EnrollmentFactor, otpVerified: boolean): EnrollmentFactor {
  if (!otpVerified) return { ...factor, status: "PENDING" };
  return { ...factor, status: "VERIFIED" };
}
