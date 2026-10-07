import { test } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { resetEmailTemplate, resetEmailAttachments } from "../server/reset-email-template.js";

test("branded reset mail has plaintext fallback, embedded PNG images, a safe link and compatible multipart MIME", async () => {
  const link = "https://tasks.abuk.in/reset-password#token=" + "a".repeat(64);
  const template = resetEmailTemplate(link), attachments = resetEmailAttachments();
  assert.match(template.subject, /LearnVerse Tasks/);
  assert.ok(template.text.includes(link)); assert.ok(template.html.includes(`href="${link}"`));
  assert.match(template.html, /15 minutes/); assert.match(template.html, /LearnVerse Tasks logo/);
  assert.ok(!template.html.includes('src="https://'));
  assert.equal(attachments.length, 2);
  for (const asset of attachments) assert.equal(asset.content.subarray(1,4).toString(), "PNG");
  const mail = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ from: { name: "LearnVerse Tasks", address: "learnverse02@gmail.com" }, to: "fixture@example.test", ...template, attachments });
  const mime = mail.message.toString();
  assert.match(mime, /multipart\/alternative/); assert.match(mime, /multipart\/related/);
  assert.match(mime, /Content-ID: <learnverse-logo>/); assert.match(mime, /Content-ID: <learnverse-reset-hero>/);
  assert.match(mime, /From: LearnVerse Tasks <learnverse02@gmail.com>/);
  assert.throws(() => resetEmailTemplate("javascript:alert(1)"));
  assert.ok(resetEmailTemplate("https://tasks.abuk.in/?q=%22%3E").html.includes("%22%3E"));
});
