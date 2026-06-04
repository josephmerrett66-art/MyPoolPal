const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

loadEnvFile();

const PORT = Number(process.env.PORT || 4173);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    const raw = require("node:fs").readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional; environment variables can still be provided by the shell or host.
  }
}

const SYSTEM_PROMPT = `
You are Pool Pal, an AI field assistant for Australian pool technicians.
Behave like an experienced senior pool technician in the technician's pocket.

Your job:
- diagnose pool and equipment problems from natural language
- give practical chemical guidance using supplied readings, approximate volume, and company settings
- explain likely root causes and field checks
- ask clarifying questions only when needed
- use company procedures and stock/product notes when provided
- keep answers field-friendly, concise, and operational
- write like a calm senior technician speaking naturally, not like a report
- most replies should be 2 to 5 short paragraphs, unless the technician asks for a checklist or detailed steps

Safety and quality rules:
- do not invent company history, job history, or procedures
- state assumptions when information is missing
- recommend escalation for electrical faults, major leaks, cracked equipment, unsafe access, repeated pump prime failure, or uncertain high-risk situations
- do not provide unsafe chemical advice
- never tell the tech to mix chemicals together
- separate diagnosis, recommendation, warning, and next step when useful
- do not use markdown headings, hashtags, bold markers, tables, or decorative formatting
- avoid long bullet-heavy answers unless the technician asks for a checklist
- prefer short plain paragraphs with simple numbered steps only when steps are genuinely useful
- avoid section labels like "Recommendation", "Warning", "Next step", or "Field checks" unless they make the answer much clearer
- do not end with generic offers like "if you want, I can..."
`.trim();

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function buildInstructions(context = {}) {
  return [
    SYSTEM_PROMPT,
    `Preferred response style: ${context.responseStyle || "Short field answer"}.`,
    `Company chemical targets: ${JSON.stringify(context.targets || {})}.`,
    `Company procedures: ${context.companyProcedures || "No company procedures provided."}`,
    `Vehicle stock and preferred products: ${context.vehicleStock || "No stock notes provided."}`,
    `Current chemical stock and weekly usage context: ${context.chemicalStockAndUsage || "No stock or usage summary provided."}`,
    `Extra company knowledge: ${context.companyKnowledge || "No extra company knowledge provided."}`
  ].join("\n\n");
}

function toResponseInput(messages = []) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: String(message.content || "")
      }
    ]
  }));
}

function getResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function handleChat(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set on the local server."
    });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid chat request." });
    return;
  }

  const model = body.model || DEFAULT_MODEL;
  const payload = {
    model,
    instructions: buildInstructions(body.context),
    input: toResponseInput(body.messages),
    max_output_tokens: 1200
  };

  try {
    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      sendJson(res, apiResponse.status, {
        error: data.error?.message || "OpenAI API request failed."
      });
      return;
    }

    const message = getResponseText(data) || "I could not read a response from the AI service.";
    sendJson(res, 200, { message, model });
  } catch (error) {
    sendJson(res, 502, {
      error: `OpenAI API connection failed: ${error.message}`
    });
  }
}

function audioFilename(contentType = "") {
  if (contentType.includes("mp4")) return "voice.m4a";
  if (contentType.includes("mpeg")) return "voice.mp3";
  if (contentType.includes("wav")) return "voice.wav";
  if (contentType.includes("webm")) return "voice.webm";
  return "voice.webm";
}

async function handleTranscribe(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set on the local server."
    });
    return;
  }

  const contentType = req.headers["content-type"] || "audio/webm";
  const audio = await readBuffer(req);

  if (!audio.length) {
    sendJson(res, 400, { error: "No audio was received." });
    return;
  }

  if (audio.length > 25 * 1024 * 1024) {
    sendJson(res, 413, { error: "Audio is too large. Keep voice notes under 25 MB." });
    return;
  }

  try {
    const form = new FormData();
    form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    form.append("prompt", "Pool technician field note. Expect Australian pool service terms, chemical readings, pump and filtration terminology.");
    form.append("file", new Blob([audio], { type: contentType }), audioFilename(contentType));

    const apiResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: form
    });

    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      sendJson(res, apiResponse.status, {
        error: data.error?.message || "OpenAI transcription failed."
      });
      return;
    }

    sendJson(res, 200, { text: data.text || "" });
  } catch (error) {
    sendJson(res, 502, {
      error: `Transcription connection failed: ${error.message}`
    });
  }
}

async function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, {
      ready: Boolean(OPENAI_API_KEY),
      model: DEFAULT_MODEL
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/transcribe") {
    await handleTranscribe(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveFile(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Pool Pal running at http://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? "OpenAI API key loaded." : "OPENAI_API_KEY is not set.");
});
