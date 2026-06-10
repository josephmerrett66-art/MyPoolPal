const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

loadEnvFile();

const PORT = Number(process.env.PORT || 4173);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const ACCESS_CODE = process.env.POOL_PAL_ACCESS_CODE || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";
const ALLOWED_CHAT_MODELS = new Set(["gpt-5.4-mini", "gpt-5.4"]);
const MAX_CHAT_OUTPUT_TOKENS = 800;
const MAX_KNOWLEDGE_OUTPUT_TOKENS = 500;
const WARNING_INPUT_TOKENS = 5000;
const HARD_INPUT_TOKENS = 9000;
const MAX_CHAT_IMAGES = 2;
const MAX_IMAGE_DATA_URL_CHARS = 1_600_000;
const DUPLICATE_WINDOW_MS = 2500;
const recentOpenAiRequests = new Map();

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

const PUBLIC_FILES = new Set([
  "/",
  "/index.html",
  "/favicon.png",
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
  "/pool-pal-icon.png",
  "/pool-pal-logo.png",
  "/pool-dose-icon.png"
]);

const PUBLIC_PATH_PREFIXES = [
  "/assets/"
];

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

function estimateTokens(value) {
  return Math.ceil(String(value || "").length / 4);
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Trimmed by Pool Pal to control OpenAI API cost.]`;
}

function safeModel(model) {
  if (ALLOWED_CHAT_MODELS.has(model)) return model;
  return ALLOWED_CHAT_MODELS.has(DEFAULT_MODEL) ? DEFAULT_MODEL : DEFAULT_CHAT_MODEL;
}

function payloadForTextAccounting(payload) {
  return JSON.parse(JSON.stringify(payload, (key, value) => {
    if (key === "image_url") return "[image omitted from text accounting]";
    return value;
  }));
}

function requestFingerprint(source, payload) {
  const raw = `${source}:${JSON.stringify(payloadForTextAccounting(payload)).slice(0, 12000)}`;
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  }
  return String(hash);
}

function duplicateGuard(source, payload) {
  const now = Date.now();
  const fingerprint = requestFingerprint(source, payload);
  const previous = recentOpenAiRequests.get(fingerprint);

  for (const [key, time] of recentOpenAiRequests.entries()) {
    if (now - time > DUPLICATE_WINDOW_MS) recentOpenAiRequests.delete(key);
  }

  if (previous && now - previous < DUPLICATE_WINDOW_MS) {
    return true;
  }

  recentOpenAiRequests.set(fingerprint, now);
  return false;
}

function payloadTextForEstimate(payload) {
  return JSON.stringify(payloadForTextAccounting({
    instructions: payload.instructions,
    input: payload.input,
    text: payload.text
  }));
}

function logOpenAiStart(source, payload, details = {}) {
  const instructionsChars = String(payload.instructions || "").length;
  const inputChars = JSON.stringify(payloadForTextAccounting(payload.input || "")).length;
  const textChars = payloadTextForEstimate(payload).length;
  const estimatedInputTokens = Math.ceil(textChars / 4);
  const messageCount = Array.isArray(payload.input) ? payload.input.length : 0;
  const level = estimatedInputTokens >= WARNING_INPUT_TOKENS ? "warn" : "log";

  console[level]("[OpenAI request]", {
    timestamp: new Date().toISOString(),
    source,
    model: payload.model,
    estimatedInputTokens,
    estimatedInputChars: textChars,
    messageCount,
    instructionsChars,
    inputChars,
    maxOutputTokens: payload.max_output_tokens,
    ...details
  });

  return estimatedInputTokens;
}

function logOpenAiEnd(source, payload, data) {
  const usage = data?.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? null;
  const totalTokens = usage.total_tokens ?? (inputTokens || outputTokens ? (inputTokens || 0) + (outputTokens || 0) : null);

  console.log("[OpenAI response]", {
    timestamp: new Date().toISOString(),
    source,
    model: payload.model,
    inputTokens,
    outputTokens,
    totalTokens
  });
}

async function callOpenAiResponses({ source, payload, details }) {
  const estimatedInputTokens = logOpenAiStart(source, payload, details);

  if (estimatedInputTokens > HARD_INPUT_TOKENS) {
    const error = new Error(`OpenAI request blocked before sending: estimated ${estimatedInputTokens} input tokens exceeds the ${HARD_INPUT_TOKENS} token safety limit.`);
    error.statusCode = 413;
    throw error;
  }

  if (duplicateGuard(source, payload)) {
    const error = new Error("Duplicate OpenAI request blocked. Please wait a moment and try again.");
    error.statusCode = 409;
    throw error;
  }

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
    const error = new Error(data.error?.message || "OpenAI API request failed.");
    error.statusCode = apiResponse.status;
    throw error;
  }

  logOpenAiEnd(source, payload, data);
  return data;
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
- prioritise relevant company knowledge entries when provided
- use the company customer message format when the technician asks you to write, rewrite, draft, or polish a customer-facing message
- use uploaded manual context when relevant manual sections are provided
- keep answers field-friendly, concise, and operational
- write like a calm senior technician speaking naturally, not like a report

Safety and quality rules:
- only answer questions related to pool servicing, pool equipment, pool chemistry, technician workflow, stock usage, or company pool procedures
- politely refuse unrelated requests and redirect the user back to pool servicing
- do not invent company history, job history, or procedures
- do not invent company knowledge entries
- do not pretend you found uploaded manual information when no relevant manual context is provided
- if uploaded manual context is provided and useful, mention the manual name naturally in the answer
- if no relevant manual context is provided for an equipment/manual question, say the answer is based on general pool servicing knowledge
- state assumptions when information is missing
- recommend escalation for electrical faults, major leaks, cracked equipment, unsafe access, repeated pump prime failure, or uncertain high-risk situations
- do not provide unsafe chemical advice
- never tell the tech to mix chemicals together
- separate diagnosis, recommendation, warning, and next step when useful
- do not use markdown headings, hashtags, bold markers, tables, or decorative formatting
- avoid long bullet-heavy answers unless the technician asks for a checklist
- prefer short plain paragraphs with simple numbered steps only when steps are genuinely useful
- avoid section labels like "Recommendation", "Warning", "Next step", or "Field checks" unless they make the answer much clearer
- when writing a customer-facing message, output the message itself in the company's style and keep it ready to copy into SMS, email, or ServiceM8
- do not end with generic offers like "if you want, I can..."

Stock action rules:
- When the technician clearly says they added, used, tipped in, dosed, or put in a chemical, return an actual_usage stock action.
- When you recommend a specific chemical amount, return a recommendation stock action.
- Do not create stock actions for vague advice without a clear amount.
- Use only these chemical keys: chlorine, acid, bicarb, salt, stabiliser.
- Convert ml to L and grams to kg in stock actions.
`.trim();

function responseStyleInstructions(style) {
  switch (style) {
    case "Medium explanation":
      return [
        "Response depth: Medium explanation.",
        "Give a practical answer with enough reasoning for a newer technician to understand why.",
        "Use around 4 to 7 short paragraphs, or a concise numbered checklist when steps are useful.",
        "Include likely cause, what to check first, why those checks matter, and when to escalate."
      ].join(" ");
    case "Extreme detail training mode":
      return [
        "Response depth: Extreme detail training mode.",
        "Assume the technician may be new and needs every small detail explained clearly.",
        "Give a thorough step-by-step walkthrough with the reasoning behind each step, common mistakes, safety notes, and escalation points.",
        "Stay practical and field-friendly, but do not skip basic details that a first-time technician would need.",
        "Longer answers are allowed in this mode, but keep the language simple and organised."
      ].join(" ");
    case "Short field answer":
    default:
      return [
        "Response depth: Short field answer.",
        "Keep the answer tight and practical for a technician in the field.",
        "Most replies should be 2 to 5 short paragraphs.",
        "Only use a short numbered checklist when it makes the next action clearer."
      ].join(" ");
  }
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function accessRequired() {
  return Boolean(ACCESS_CODE);
}

function cloudAuthRequired() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function accessCodeFrom(req, body = {}) {
  return String(req.headers["x-pool-pal-access"] || body.accessCode || "").trim();
}

function hasAccess(req, body = {}) {
  if (!accessRequired()) return true;
  return accessCodeFrom(req, body) === ACCESS_CODE;
}

function denyAccess(res) {
  sendJson(res, 401, {
    error: "Pool Pal is private. Enter the access code to continue.",
    accessRequired: true
  });
}

function bearerTokenFrom(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

async function verifySupabaseUser(req) {
  if (!cloudAuthRequired()) return null;
  const token = bearerTokenFrom(req);
  if (!token) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) return null;
  return response.json();
}

async function requireCloudAuth(req, res) {
  if (!cloudAuthRequired()) return true;
  const user = await verifySupabaseUser(req);
  if (user?.id) return true;

  sendJson(res, 401, {
    error: "Sign in to Pool Pal before using the AI.",
    loginRequired: true
  });
  return false;
}

function latestUserText(messages = []) {
  const latest = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === "user");
  return String(latest?.content || "");
}

function validateChatImages(images = []) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_CHAT_IMAGES).map((image, index) => {
    const dataUrl = String(image?.dataUrl || "");
    const mimeType = String(image?.mimeType || "");
    const name = truncateText(image?.name || `Photo ${index + 1}`, 80);

    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mimeType)) {
      const error = new Error("Only JPG, PNG, or WebP photos can be sent to Pool Pal.");
      error.statusCode = 400;
      throw error;
    }

    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
      const error = new Error("Photo upload format was not recognised.");
      error.statusCode = 400;
      throw error;
    }

    if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      const error = new Error("Photo is too large. Please choose a smaller image.");
      error.statusCode = 413;
      throw error;
    }

    return { dataUrl, mimeType, name };
  });
}

function isClearlyOffTopic(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;

  const poolTerms = [
    "pool", "spa", "chlorine", "chlorinator", "pump", "filter", "skimmer", "salt", "cell",
    "ph", "alkalinity", "acid", "bicarb", "stabiliser", "stabilizer", "cya", "green",
    "cloudy", "cleaner", "suction", "flow", "prime", "priming", "cartridge", "sand filter",
    "water test", "readings", "heater", "astral", "zodiac", "hayward", "pentair"
  ];
  if (poolTerms.some((term) => lower.includes(term))) return false;

  const offTopicTerms = [
    "write code", "make an app", "javascript", "python", "essay", "homework", "assignment",
    "resume", "cover letter", "song", "poem", "recipe", "crypto", "stock market", "legal letter",
    "marketing plan", "business plan", "translate", "summarise this article", "summarize this article"
  ];
  return offTopicTerms.some((term) => lower.includes(term));
}

function isCustomerMessageRequest(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  const messageTerms = [
    "write a message", "write message", "draft a message", "customer message", "text the customer",
    "sms", "email the customer", "service m8 note", "servicem8 note", "make this sound professional",
    "send to the customer", "tell the customer", "message to customer", "customer text"
  ];
  return messageTerms.some((term) => lower.includes(term));
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
  const rawTargets = context.targets || {};
  const targets = {
    pH: truncateText(rawTargets.pH, 20),
    chlorine: truncateText(rawTargets.chlorine, 20),
    alkalinity: truncateText(rawTargets.alkalinity, 20),
    maxAcidMl: truncateText(rawTargets.maxAcidMl, 20)
  };
  const safeContext = {
    responseStyle: context.responseStyle || "Short field answer",
    targets,
    companyProcedures: truncateText(context.companyProcedures, 1400),
    vehicleStock: truncateText(context.vehicleStock, 900),
    chemicalStockAndUsage: truncateText(context.chemicalStockAndUsage, 900),
    companyKnowledge: truncateText(context.companyKnowledge, 1400),
    companyKnowledgeContext: truncateText(context.companyKnowledgeContext, 1800),
    manualContext: truncateText(context.manualContext, 2200),
    messageFormat: {
      tone: truncateText(context.messageFormat?.tone, 80),
      greeting: truncateText(context.messageFormat?.greeting, 120),
      signoff: truncateText(context.messageFormat?.signoff, 160),
      rules: truncateText(context.messageFormat?.rules, 1000)
    }
  };

  const readingAlerts = readingGuidanceAlerts(context);
  const customerMessageMode = isCustomerMessageRequest(latestUserText(context.messages || []));
  const messageFormatText = [
    `Tone: ${safeContext.messageFormat.tone || "Friendly and professional"}`,
    `Greeting: ${safeContext.messageFormat.greeting || "Use a simple greeting if the customer name is known."}`,
    `Sign-off: ${safeContext.messageFormat.signoff || "Use the company sign-off if known."}`,
    `Rules: ${safeContext.messageFormat.rules || "Keep customer messages clear, polite, and copy-ready."}`
  ].join("\n");

  return [
    SYSTEM_PROMPT,
    responseStyleInstructions(safeContext.responseStyle),
    customerMessageMode
      ? "Customer message mode: the technician is asking for customer-facing wording. Write the actual message only, using the company customer message format. Do not explain your reasoning unless the technician asks for it. If a customer name is not provided, use a neutral greeting or omit the name."
      : "Customer message mode: not detected. Only write customer-facing wording if the technician asks for it.",
    `Company customer message format:\n${messageFormatText}`,
    "Company guidance priority: if company procedures, extra company knowledge, or learned company knowledge are relevant to the technician's readings or symptoms, treat them as mandatory operating guidance and apply them before generic pool advice. Do not ignore a relevant company rule just because the technician did not ask about it directly.",
    `Company chemical targets: ${JSON.stringify(safeContext.targets)}.`,
    `Detected company reading alerts: ${readingAlerts || "No automatic reading-specific company alert detected."}`,
    `Company procedures: ${safeContext.companyProcedures || "No company procedures provided."}`,
    `Vehicle stock and preferred products: ${safeContext.vehicleStock || "No stock notes provided."}`,
    `Current chemical stock and weekly usage context: ${safeContext.chemicalStockAndUsage || "No stock or usage summary provided."}`,
    `Extra company knowledge: ${safeContext.companyKnowledge || "No extra company knowledge provided."}`,
    `Relevant learned company knowledge: ${safeContext.companyKnowledgeContext || "No relevant learned company knowledge found for this question."}`,
    `Uploaded manual context: ${safeContext.manualContext || "No relevant uploaded manual sections found for this question."}`
  ].join("\n\n");
}

function extractPhReading(text) {
  const match = String(text || "").match(/\bph\b\s*(?:is|=|:|at|reading)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readingGuidanceAlerts(context = {}) {
  const latestText = latestUserText(context.messages || []);
  const ph = extractPhReading(latestText);
  if (ph === null || ph >= 7.2) return "";

  const companyText = [
    context.companyProcedures,
    context.companyKnowledge,
    context.companyKnowledgeContext
  ].join("\n").toLowerCase();

  if (!companyText.includes("acid")) return "";

  return [
    `Mandatory company reading alert: technician reported pH ${ph}, which is below 7.2.`,
    "Before giving normal pH dosing advice, remind the technician to check the automatic acid doser/controller, because the company guideline says low pH may mean the acid doser needs recalibrating or is running too long each day."
  ].join(" ");
}

function toResponseInput(messages = []) {
  const recentMessages = messages
    .slice(-8)
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: truncateText(message.content, message.role === "assistant" ? 1200 : 1600),
      images: message.role === "user" ? (message.images || []) : []
    }));
  let latestUserIndex = -1;
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    if (recentMessages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  return recentMessages.map((message, index) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: String(message.content || "")
      },
      ...(index === latestUserIndex ? validateChatImages(message.images) : []).map((image) => ({
        type: "input_image",
        image_url: image.dataUrl,
        detail: "low"
      }))
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

const CHAT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description: "Natural field-friendly assistant reply with no markdown decoration."
    },
    stock_actions: {
      type: "array",
      description: "Structured chemical recommendation or actual usage records to apply in the app.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["recommendation", "actual_usage"]
          },
          chemical: {
            type: "string",
            enum: ["chlorine", "acid", "bicarb", "salt", "stabiliser"]
          },
          amount: {
            type: "number"
          },
          unit: {
            type: "string",
            enum: ["L", "kg"]
          },
          note: {
            type: "string"
          }
        },
        required: ["type", "chemical", "amount", "unit", "note"]
      }
    }
  },
  required: ["message", "stock_actions"]
};

function parseStructuredChat(data) {
  const text = getResponseText(data);
  try {
    const parsed = JSON.parse(text);
    return {
      message: String(parsed.message || "").trim(),
      stockActions: Array.isArray(parsed.stock_actions) ? parsed.stock_actions : []
    };
  } catch {
    return {
      message: text || "I could not read a response from the AI service.",
      stockActions: []
    };
  }
}

const KNOWLEDGE_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    equipment_type: { type: "string" },
    equipment_brand: { type: "string" },
    issue_category: { type: "string" },
    knowledge_entry: { type: "string" }
  },
  required: ["title", "equipment_type", "equipment_brand", "issue_category", "knowledge_entry"]
};

function parseKnowledgeEntry(data) {
  const text = getResponseText(data);
  try {
    const parsed = JSON.parse(text);
    return {
      title: String(parsed.title || "Technician improvement").trim(),
      equipmentType: String(parsed.equipment_type || "General").trim(),
      equipmentBrand: String(parsed.equipment_brand || "Unknown").trim(),
      issueCategory: String(parsed.issue_category || "Company knowledge").trim(),
      knowledgeEntry: String(parsed.knowledge_entry || "").trim()
    };
  } catch {
    return {
      title: "Technician improvement",
      equipmentType: "General",
      equipmentBrand: "Unknown",
      issueCategory: "Company knowledge",
      knowledgeEntry: text.trim()
    };
  }
}

async function handleKnowledgeExtract(req, res) {
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
    sendJson(res, 400, { error: "Invalid knowledge request." });
    return;
  }

  if (!hasAccess(req, body)) {
    denyAccess(res);
    return;
  }

  if (!(await requireCloudAuth(req, res))) return;

  const question = truncateText(body.question, 1800);
  const answer = truncateText(body.answer, 1800);
  const improvement = truncateText(body.improvement, 1200);

  const payload = {
    model: safeModel(body.model || DEFAULT_MODEL),
    instructions: [
      "You convert pool technician answer improvements into structured company knowledge.",
      "The technician is teaching how their company prefers to handle a real field situation.",
      "Use the original question, original assistant answer, and technician improvement.",
      "Extract the likely equipment type, brand, issue category, and a reusable knowledge entry.",
      "Do not overstate certainty. Use Unknown when brand or equipment type is not clear.",
      "The knowledge entry should be practical, concise, and written as future guidance for Pool Pal."
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
              {
            type: "input_text",
            text: [
              `Original technician question:\n${question}`,
              `Original Pool Pal answer:\n${answer}`,
              `Technician improvement:\n${improvement}`
            ].join("\n\n")
          }
        ]
      }
    ],
    max_output_tokens: MAX_KNOWLEDGE_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "pool_pal_company_knowledge_entry",
        strict: true,
        schema: KNOWLEDGE_ENTRY_SCHEMA
      }
    }
  };

  try {
    const data = await callOpenAiResponses({
      source: "handleKnowledgeExtract",
      payload,
      details: {
        questionChars: String(body.question || "").length,
        answerChars: String(body.answer || "").length,
        improvementChars: String(body.improvement || "").length
      }
    });

    sendJson(res, 200, {
      entry: parseKnowledgeEntry(data)
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      error: `Knowledge extraction connection failed: ${error.message}`
    });
  }
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

  if (!hasAccess(req, body)) {
    denyAccess(res);
    return;
  }

  if (!(await requireCloudAuth(req, res))) return;

  if (isClearlyOffTopic(latestUserText(body.messages))) {
    sendJson(res, 200, {
      message: "Pool Pal is set up only for pool servicing help. Ask me about pool readings, equipment, chemicals, procedures, stock, or troubleshooting and I can help.",
      stockActions: [],
      model: "no-openai-call"
    });
    return;
  }

  const model = safeModel(body.model || DEFAULT_MODEL);
  let responseInput;
  try {
    responseInput = toResponseInput(body.messages);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const payload = {
    model,
    instructions: buildInstructions({ ...(body.context || {}), messages: body.messages }),
    input: responseInput,
    max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "pool_pal_chat_response",
        strict: true,
        schema: CHAT_RESPONSE_SCHEMA
      }
    }
  };

  try {
    const context = body.context || {};
    const data = await callOpenAiResponses({
      source: "handleChat",
      payload,
      details: {
        rawMessageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        sentMessageCount: payload.input.length,
        imageCount: payload.input.reduce((count, item) => count + item.content.filter((part) => part.type === "input_image").length, 0),
        companyProceduresChars: String(context.companyProcedures || "").length,
        companyKnowledgeChars: String(context.companyKnowledge || "").length,
        companyKnowledgeContextChars: String(context.companyKnowledgeContext || "").length,
        manualContextChars: String(context.manualContext || "").length,
        stockContextChars: String(context.chemicalStockAndUsage || "").length
      }
    });

    const structured = parseStructuredChat(data);
    sendJson(res, 200, {
      message: structured.message,
      stockActions: structured.stockActions,
      model
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
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
  if (!hasAccess(req)) {
    denyAccess(res);
    return;
  }

  if (!(await requireCloudAuth(req, res))) return;

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
    const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
    console.log("[OpenAI request]", {
      timestamp: new Date().toISOString(),
      source: "handleTranscribe",
      model: transcribeModel,
      audioBytes: audio.length,
      contentType
    });

    const form = new FormData();
    form.append("model", transcribeModel);
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

    console.log("[OpenAI response]", {
      timestamp: new Date().toISOString(),
      source: "handleTranscribe",
      model: transcribeModel,
      inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null
    });

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
  const publicPath = safePath === "/" ? "/" : `/${safePath.replace(/^[/\\]+/, "")}`;
  const isAllowed = PUBLIC_FILES.has(publicPath) || PUBLIC_PATH_PREFIXES.some((prefix) => publicPath.startsWith(prefix));

  if (!isAllowed || publicPath.includes("/.") || publicPath.endsWith(".js") || publicPath.endsWith(".json")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const filePath = path.join(__dirname, publicPath === "/" ? "index.html" : publicPath);

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
      model: safeModel(DEFAULT_MODEL),
      accessRequired: accessRequired(),
      loginRequired: cloudAuthRequired()
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/config") {
    sendJson(res, 200, {
      supabase: {
        configured: cloudAuthRequired(),
        loginRequired: cloudAuthRequired(),
        url: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/access") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "Invalid access request." });
      return;
    }

    if (hasAccess(req, body)) {
      sendJson(res, 200, { ok: true });
    } else {
      denyAccess(res);
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/knowledge/extract") {
    await handleKnowledgeExtract(req, res);
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
  if (DEFAULT_MODEL !== safeModel(DEFAULT_MODEL)) {
    console.warn(`OPENAI_MODEL=${DEFAULT_MODEL} is not allowed for chat. Using ${safeModel(DEFAULT_MODEL)} instead.`);
  }
});
