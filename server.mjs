import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

export const AI_TIMEOUT_MS = 300;
export const MAX_BODY_BYTES = 64 * 1024;
export const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

// Тело запроса -> текст заявки. Любой мусор (битый JSON, не объект, нестрока, пустая строка) — отказ.
export function parseBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  if (typeof body.text !== "string") return { ok: false };
  const text = body.text.trim();
  if (text === "") return { ok: false };
  return { ok: true, text };
}

// Ответ модели -> готовый результат или null, если ответ непригоден (не JSON, чужой топик, пустой черновик).
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { topic, draft } = parsed;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string") return null;
  const trimmedDraft = draft.trim();
  if (trimmedDraft === "") return null;
  return { topic, draft: trimmedDraft };
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestTriage(text) {
  try {
    const raw = await classify(text, { signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
    return parseModelOutput(raw);
  } catch {
    // Таймаут, отмена по сигналу и любые ошибки провайдера одинаково уходят менеджеру на ручную проверку.
    return null;
  }
}

export async function handleTriage(request, response) {
  const body = parseBody(await readBody(request));
  if (!body.ok) return json(response, 400, { status: "invalid_input" });
  const result = await requestTriage(body.text);
  if (result === null) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...result });
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch (error) {
      if (error?.code === "BODY_TOO_LARGE") return json(response, 400, { status: "invalid_input" });
      json(response, 500, { status: "server_error" });
    }
  });
}

export function start(port = Number(process.env.PORT || 3000)) {
  return createApp().listen(port, "127.0.0.1");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}


