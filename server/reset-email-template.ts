import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function resetEmailTemplate(link: string) {
  const url = new URL(link);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid recovery link");
  const href = escape(url.href), host = escape(url.host);
  return {
    subject: "LearnVerse Tasks · Reset your password",
    text: `LearnVerse Tasks — Account security\n\nReset your password\n\nWe received a request to reset your LearnVerse Tasks password. Open this link within 15 minutes:\n${url.href}\n\nThis link works once. Changing your password signs out all sessions and revokes integration credentials. If you did not request a reset, ignore this email. Your password stays unchanged.\n\nLearnVerse Tasks\n${url.origin}\nThis is an automated account-security email.`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnVerse Tasks — Password reset</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;color:#25344b;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your secure password reset link for LearnVerse Tasks. Valid for 15 minutes.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f6fb;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 8px 24px;"><table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td width="48"><img src="cid:learnverse-logo" width="40" height="40" alt="LearnVerse Tasks logo" style="display:block;border:0;"></td>
<td style="font-size:19px;font-weight:700;letter-spacing:-.4px;color:#25344b;">LearnVerse Tasks<br><span style="font-size:10px;letter-spacing:2px;font-weight:400;color:#77839a;">ACCOUNT SECURITY</span></td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e6eaf2;border-radius:16px;overflow:hidden;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
<tr><td><img src="cid:learnverse-reset-hero" width="560" height="180" alt="A secure workspace with task cards and a lock" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:15px 15px 0 0;"></td></tr>
<tr><td style="padding:32px 28px 12px;"><span style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#6852c9;">LET’S GET YOU BACK TO YOUR WORK</span>
<h1 style="font-size:28px;line-height:1.2;letter-spacing:-.7px;margin:14px 0 18px;color:#25344b;">Reset your password</h1>
<p style="font-size:15px;line-height:1.7;margin:0 0 24px;color:#627089;">We received a request to reset your LearnVerse Tasks password. Choose a new password and return to your projects.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#5c50d9" style="border-radius:8px;"><a href="${href}" style="display:inline-block;padding:15px 25px;border:1px solid #5c50d9;border-radius:8px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">Reset my password &nbsp;→</a></td></tr></table>
<p style="font-size:12px;line-height:1.6;color:#77839a;margin:14px 0 24px;">Valid for <strong>15 minutes</strong> · Can be used once</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#f5f3ff" style="border-radius:8px;padding:16px;color:#627089;font-size:13px;line-height:1.7;">After you reset your password, all sessions will be signed out and integration credentials revoked. Sign in again with your new password.</td></tr></table>
<p style="font-size:13px;line-height:1.7;margin:22px 0 0;color:#627089;">Didn’t request this? You can safely ignore this email. Your password will stay unchanged.</p>
</td></tr>
<tr><td style="padding:20px 28px 28px;"><p style="font-size:11px;line-height:1.7;color:#77839a;margin:0 0 8px;">Button not working? Copy this link into your browser:</p><a href="${href}" style="font-size:11px;line-height:1.7;color:#6852c9;word-break:break-all;overflow-wrap:anywhere;">${href}</a></td></tr>
</table></td></tr>
<tr><td align="center" style="padding:24px 12px;font-size:11px;line-height:1.8;color:#8a95a8;">Sent by <strong>LearnVerse Tasks</strong><br><a href="${escape(url.origin)}" style="color:#6852c9;text-decoration:none;">${host}</a><br>This is an automated account-security email.</td></tr>
</table></td></tr></table></body></html>`,
  };
}
export function resetEmailAttachments() {
  const directory = process.env.LAMBDA_TASK_ROOT ? resolve(process.env.LAMBDA_TASK_ROOT, "mail-assets") : resolve("server/mail-assets");
  return [
    { filename: "learnverse-tasks-logo.png", content: readFileSync(resolve(directory, "logo.png")), cid: "learnverse-logo", contentDisposition: "inline" as const },
    { filename: "learnverse-tasks-reset.png", content: readFileSync(resolve(directory, "reset-hero.png")), cid: "learnverse-reset-hero", contentDisposition: "inline" as const },
  ];
}
