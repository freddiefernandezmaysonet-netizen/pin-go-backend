// Approved sender identities shared by API, scheduled delivery and retries.
// These domains are verified in Resend. Reply-To remains the caller's responsibility.
export const EMAIL_SENDERS = {
  authentication: "Pin&Go Security <no-reply@auth.pin-ngo.com>",
  reservations: "Pin&Go Reservations <reservations@pin-ngo.com>",
  access: "Pin&Go Access <access@pin-ngo.com>",
  cleaning: "Pin&Go Cleaning <cleaning@pin-ngo.com>",
  incidents: "Pin&Go Incidents <incidents@incidents.pin-ngo.com>",
  channexAlerts: "Pin&Go Alerts <alerts@incidents.pin-ngo.com>",
  billing: "Pin&Go Billing <billing@pin-ngo.com>",
  sales: "Pin&Go <sales@pin-ngo.com>",
} as const;

export type EmailPurpose = keyof typeof EMAIL_SENDERS;

export function getEmailSender(purpose: EmailPurpose): string {
  return EMAIL_SENDERS[purpose];
}
