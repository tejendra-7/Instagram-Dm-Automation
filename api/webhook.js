const axios = require("axios");

// ─── CONFIG ──────────────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID;

const GRAPH_API = "https://graph.facebook.com/v21.0";

// ─── RATE LIMITER (200 calls / hour — Meta free tier) ────
const RATE_LIMIT = 200;            // max API calls per window
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour in ms
const apiCallTimestamps = [];      // in-memory sliding window

function isRateLimited() {
  const now = Date.now();
  // Remove timestamps older than 1 hour
  while (apiCallTimestamps.length > 0 && apiCallTimestamps[0] <= now - RATE_WINDOW_MS) {
    apiCallTimestamps.shift();
  }
  return apiCallTimestamps.length >= RATE_LIMIT;
}

function recordApiCall() {
  apiCallTimestamps.push(Date.now());
}

function remainingCalls() {
  const now = Date.now();
  while (apiCallTimestamps.length > 0 && apiCallTimestamps[0] <= now - RATE_WINDOW_MS) {
    apiCallTimestamps.shift();
  }
  return RATE_LIMIT - apiCallTimestamps.length;
}

// ─── REEL CONFIG (per-reel keywords + link) ─────────────
// Each media_id maps to:
//   keywords : array of trigger words/emojis (case-insensitive match)
//   link     : the URL to send in the DM
//
// A comment triggers the DM if it contains ANY of the reel's keywords.
// You can use words, emojis, or a mix — and as many as you want.
const REELS = {
  "18074903702636459": {
    keywords: ["link", "🙌"],
    link: "https://www.remove.bg/",
  },
  "18000426086902720": {
    keywords: ["job", "interested"],
    link: "https://www.youtube.com/shorts/4NmUkyx6WcA",
  },
  "18094898834005203": {
    keywords: ["🔥", "send", "link"],
    link: "https://www.linkedin.com/in/tejendra-b-95b5b8231/",
  },
};

// ─── HELPER: Send DM via Instagram Graph API ────────────
async function sendDM(recipientId, messageText) {
  // Check rate limit before making the API call
  if (isRateLimited()) {
    console.warn(`🚫 Rate limit reached (${RATE_LIMIT}/hr). Skipping DM to ${recipientId}.`);
    return null;
  }

  const url = `${GRAPH_API}/${IG_BUSINESS_ID}/messages`;

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText },
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  recordApiCall();
  console.log(`📊 API calls remaining: ${remainingCalls()}/${RATE_LIMIT}`);

  return response.data;
}

// ─── HELPER: Delay (ms) ─────────────────────────────────
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HELPER: Process a single comment event ─────────────
async function handleComment(userId, mediaId, matchedKeyword) {
  try {
    // Message #1 — prompt to follow
    await sendDM(userId, "Follow the page to unlock the link 👀");
    console.log(`✅ DM #1 sent to ${userId} (keyword: ${matchedKeyword})`);

    // Wait 5 seconds
    await delay(5_000);

    // Message #2 — deliver the link
    const reelConfig = REELS[mediaId];
    const reelLink = reelConfig?.link || "https://www.google.com/";
    await sendDM(userId, `Here is the link 👇 ${reelLink}`);
    console.log(`✅ DM #2 sent to ${userId} (media: ${mediaId})`);
  } catch (err) {
    console.error(`❌ Failed to DM ${userId}:`, err?.response?.data || err.message);
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────
module.exports = async function handler(req, res) {
  // ── GET: Webhook Verification ──────────────────────────
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  // ── POST: Incoming Webhook Event ───────────────────────
  if (req.method === "POST") {
    const body = req.body;

    // Safety check
    if (!body || !body.entry) {
      return res.status(200).send("EVENT_RECEIVED");
    }

    // Process each entry
    for (const entry of body.entry) {
      const changes = entry.changes || [];

      for (const change of changes) {
        // Only care about comment events
        if (change.field !== "comments") continue;

        const value = change.value || {};
        const commentText = (value.text || "").toLowerCase();
        const userId = value.from?.id;
        const mediaId = value.media?.id;

        if (!userId || !mediaId) {
          console.warn("⚠️ Missing userId or mediaId, skipping.");
          continue;
        }

        // Look up this reel's config and check for matching keyword
        const reelConfig = REELS[mediaId];
        if (!reelConfig) continue; // reel not configured, ignore

        const matchedKeyword = reelConfig.keywords.find((kw) =>
          commentText.includes(kw.toLowerCase())
        );
        if (!matchedKeyword) continue; // no keyword match, ignore

        console.log(`📩 Keyword "${matchedKeyword}" detected from ${userId} on media ${mediaId}`);

        // Fire & forget — don't block the webhook response
        handleComment(userId, mediaId, matchedKeyword).catch((err) =>
          console.error("❌ handleComment error:", err.message)
        );
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  }

  // ── Anything else ──────────────────────────────────────
  return res.status(405).send("Method Not Allowed");
};
