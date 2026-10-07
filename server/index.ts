import "dotenv/config";
import express from "express";
import { createServer } from "vite";
import { createApp } from "./app.js";
import { resolve } from "node:path";
const { app } = await createApp(
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
  process.env.MONGODB_DATABASE,
);
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist"));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.split("/").at(-1)?.includes(".")) return next();
    res.sendFile(resolve("dist/index.html"));
  });
}
else {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log(
      "LearnVerse Tasks listening on port " + (process.env.PORT ?? 3000),
    ),
);
