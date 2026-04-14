import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(params: {
  to: string;
  token: string;
}) {
  const resetUrl = `${process.env.PASSWORD_RESET_URL}?token=${params.token}`;

  await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to: params.to,
    subject: "Reset your password - Pin&Go",
    html: `
      <h2>Password Reset</h2>
      <p>You requested to reset your password.</p>
      <p>Click below:</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>If you did not request this, ignore this email.</p>
    `,
  });
}