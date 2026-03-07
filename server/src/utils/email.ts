import nodemailer from 'nodemailer';

const ADMIN_EMAIL = 'justin@dubllabs.com';

// Uses Gmail SMTP by default — set SMTP_USER and SMTP_PASS env vars
// For other providers, set SMTP_HOST and SMTP_PORT as well
function getTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  if (!user || !pass) {
    return null; // Email not configured — will log instead
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export async function sendPayoutRequestEmail(
  userName: string,
  venmoUsername: string,
  amountCents: number,
) {
  const amount = (amountCents / 100).toFixed(2);
  const subject = `Payout Request: $${amount} to @${venmoUsername}`;
  const text = [
    `New payout request from ${userName}`,
    ``,
    `Amount: $${amount}`,
    `Venmo: @${venmoUsername}`,
    ``,
    `Send via Venmo and mark as paid in the admin panel.`,
  ].join('\n');

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL NOT CONFIGURED] ${subject}\n${text}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: ADMIN_EMAIL,
      subject,
      text,
    });
    console.log(`Payout email sent to ${ADMIN_EMAIL}`);
  } catch (err) {
    console.error('Failed to send payout email:', err);
  }
}
