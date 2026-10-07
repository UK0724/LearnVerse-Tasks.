import nodemailer from "nodemailer";
import { resetEmailTemplate, resetEmailAttachments } from "./reset-email-template.js";

export type ResetMailer = (email: string, link: string) => Promise<void>;
export function configuredResetMailer(): ResetMailer | undefined {
  const from = process.env.RESET_EMAIL_FROM;
  if (!from) return;
  if (process.env.RESET_EMAIL_TRANSPORT === "smtp" && process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 465);
    const smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
    return async (email, link) => { await smtp.sendMail({ from: { name: "LearnVerse Tasks", address: from }, to: email, ...resetEmailTemplate(link), attachments: resetEmailAttachments() }); };
  }
}
