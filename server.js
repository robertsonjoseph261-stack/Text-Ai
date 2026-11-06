// Text ai - an SMS chatbot for a spare Android phone running SMSGate
// (SMS Gateway for Android, sms-gate.app). Zero dependencies (Node 18+).
// Flow: someone texts your MTN number -> SMSGate app POSTs the text here -> Gemini replies
//       -> SMSGate sends the reply from your SIM.
//
// Env vars needed:
//   GEMINI_API_KEY      from aistudio.google.com/apikey
//   GEMINI_MODEL        optional, default gemini-2.5-flash
//   SMSGATE_USER        username shown on the Home tab of the SMSGate app
//   SMSGATE_PASS        password shown on the Home tab of the SMSGate app
//   SMSGATE_URL         optional, default https://api.sms-gate.app/3rdparty/v1/messages (Cloud mode)
//   PORT                default 3000

const http = require("http");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SMSGATE_URL =
  process.env.SMSGATE_URL || "https://api.sms-gate.app/3rdparty/v1/messages";
const SYSTEM =
  "You are Text ai, an assistant people chat with over SMS. " +
  "Reply in plain text only, no markdown, no emojis. Keep every reply under 300 characters. " +
  "Be clear and friendly. Reply in the language the person writes in.";

const histories = new Map(); // phone -> [{role, content}]

async function askGemini(phone, text) {
  const h = histories.get(phone) || [];
  h.push({ role: "user", content: text });
  while (h.length > 10) h.shift(); // keep last 10 messages
  while (h.length && h[0].role !== "user") h.shift();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: h.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 200 },
      }),
    }
  );
  const data = await res.json();
  const reply =
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "Sorry, I could not answer that. Try again.";
  h.push({ role: "assistant", content: reply });
  histories.set(phone, h);
  return reply;
}

async function sendSms(to, text) {
  const auth = Buffer.from(
    `${process.env.SMSGATE_USER}:${process.env.SMSGATE_PASS}`
  ).toString("base64");
  const res = await fetch(SMSGATE_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
  });
  if (!res.ok) console.error("send failed:", res.status, await res.text());
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sms") {
      res.writeHead(200).end("Text ai is running");
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      res.writeHead(200).end("OK"); // answer first so SMSGate does not retry
      try {
        const evt = JSON.parse(raw);
        if (evt.event !== "sms:received") return;
        const p = evt.payload || {};
        const from = p.phoneNumber || p.sender; // the person texting you
        const text = (p.message || "").trim();
        if (!from || !text) return;
        console.log("incoming:", from, text);
        const reply = await askGemini(from, text);
        await sendSms(from, reply);
      } catch (e) {
        console.error("error:", e);
      }
    });
  })
  .listen(PORT, () => console.log("Text ai listening on " + PORT));
