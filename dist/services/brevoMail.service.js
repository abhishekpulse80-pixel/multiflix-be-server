import { env, isProd } from '../config/env.js';
const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
function brevoConfigured() {
    return Boolean(env.brevoApiKey && env.brevoSenderEmail);
}
/**
 * Sends the 4-digit password reset OTP via Brevo Transactional Email.
 * No-op when API key / sender are unset (caller should log OTP in dev).
 */
export async function sendPasswordResetOtpEmail(toEmail, otp) {
    if (!brevoConfigured()) {
        return;
    }
    const subject = 'Your Multiflix password reset code';
    const textContent = [
        `Your password reset code is: ${otp}`,
        '',
        'It expires in 10 minutes. If you did not request this, you can ignore this email.',
    ].join('\n');
    const digits = otp.split('');
    const digitBoxes = digits
        .map((d) => `<td style="width:52px;height:58px;background-color:#F0F3FF;border-radius:12px;text-align:center;vertical-align:middle;font-size:26px;font-weight:700;color:#246BFD;font-family:'SF Pro Display',system-ui,sans-serif;letter-spacing:0;">${d}</td>`)
        .join('<td style="width:10px;"></td>');
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#F5F6FA;font-family:'SF Pro Display',system-ui,-apple-system,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F6FA;padding:40px 0;">
    <tr><td align="center">
      <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="max-width:460px;width:100%;background-color:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <!-- Header bar -->
        <tr>
          <td style="background:linear-gradient(135deg,#246BFD 0%,#5B8FFF 100%);padding:32px 36px 28px;text-align:center;">
            <div style="font-size:22px;font-weight:700;color:#FFFFFF;letter-spacing:-0.3px;">Multiflix</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 36px 16px;">
            <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#0D0D0D;">Password Reset</p>
            <p style="margin:0 0 28px;font-size:15px;line-height:22px;color:#6B7280;">
              We received a request to reset your account password. Enter this code in the app to continue:
            </p>
            <!-- OTP boxes -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
              <tr>${digitBoxes}</tr>
            </table>
            <!-- Timer badge -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
              <tr>
                <td style="background-color:#FFF7ED;border-radius:8px;padding:8px 16px;">
                  <span style="font-size:13px;color:#D97706;font-weight:600;">Expires in 10 minutes</span>
                </td>
              </tr>
            </table>
            <div style="height:1px;background-color:#F0F0F0;margin:0 0 20px;"></div>
            <p style="margin:0;font-size:13px;line-height:19px;color:#9CA3AF;">
              If you didn't request this code, you can safely ignore this email. Your password won't change unless you enter the code above.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 36px 28px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#C0C0C0;">&copy; ${new Date().getFullYear()} Multiflix. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
    const res = await fetch(BREVO_API, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'api-key': env.brevoApiKey,
        },
        body: JSON.stringify({
            sender: {
                name: env.brevoSenderName,
                email: env.brevoSenderEmail,
            },
            to: [{ email: toEmail }],
            subject,
            textContent,
            htmlContent,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Brevo send failed (${String(res.status)}): ${body.slice(0, 500)}`);
    }
}
export function shouldLogOtpToConsole() {
    return !isProd && !brevoConfigured();
}
export function logBrevoMisconfig() {
    if (isProd && !brevoConfigured()) {
        console.warn('[brevo] BREVO_API_KEY / BREVO_SENDER_EMAIL not set — password reset emails will not be sent.');
    }
}
