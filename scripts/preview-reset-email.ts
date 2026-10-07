import { mkdir, writeFile } from "node:fs/promises";
import { resetEmailTemplate, resetEmailAttachments } from "../server/reset-email-template.js";
const template = resetEmailTemplate("https://tasks.abuk.in/reset-password#token=" + "0".repeat(64));
let html = template.html;
for (const asset of resetEmailAttachments()) html = html.replace("cid:" + asset.cid, "data:image/png;base64," + asset.content.toString("base64"));
await mkdir("output/email-preview", { recursive: true });
await writeFile("output/email-preview/index.html", html);
console.log("Branded email preview saved with an inactive example token.");
