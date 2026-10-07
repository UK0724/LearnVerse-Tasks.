import serverlessExpress from "@codegenie/serverless-express";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { createApp } from "./app.js";
import { createHash, timingSafeEqual } from "node:crypto";

let ready: Promise<ReturnType<typeof serverlessExpress>> | undefined;
async function initialize() {
  let uri = process.env.MONGODB_URI;
  if (process.env.MONGODB_PARAMETER) {
    const result = await new SSMClient({}).send(new GetParameterCommand({
      Name: process.env.MONGODB_PARAMETER,
      WithDecryption: true,
    }));
    uri = result.Parameter?.Value;
  }
  if (!uri) throw new Error("MongoDB connection is not configured");
  if (process.env.SMTP_PARAMETER) {
    const result = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.SMTP_PARAMETER, WithDecryption: true }));
    const smtp = JSON.parse(result.Parameter?.Value ?? "{}");
    if (smtp.user !== process.env.RESET_EMAIL_FROM || typeof smtp.password !== "string" || !smtp.password) throw new Error("Reset email is not configured");
    process.env.SMTP_USER = smtp.user;
    process.env.SMTP_PASSWORD = smtp.password;
  }
  const { app } = await createApp(uri, process.env.MONGODB_DATABASE);
  return serverlessExpress({ app });
}

export async function handler(event: any, context: any) {
  context.callbackWaitsForEmptyEventLoop = false;
  if (process.env.ORIGIN_TOKEN) {
    const incoming = event.headers?.["x-learnverse-origin"] ?? "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(incoming), digest(process.env.ORIGIN_TOKEN))) {
      return { statusCode: 403, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "ORIGIN_REJECTED", message: "Request origin rejected" } }) };
    }
  }
  try {
    ready ??= initialize();
    const handle = await ready;
    return await handle(event, context);
  } catch {
    ready = undefined;
    console.error("API initialization failed");
    return {
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable" } }),
    };
  }
}
