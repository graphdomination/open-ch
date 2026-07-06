const express = require("express");
const cors = require("cors");
const { Chess } = require("chess.js");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let stockfishProcess = null;
let stockfishReadyPromise = null;
let analysisQueue = Promise.resolve();

function initStockfishEngine() {
  if (stockfishReadyPromise) return stockfishReadyPromise;

  stockfishReadyPromise = new Promise((resolve, reject) => {
    const enginePath = path.join(__dirname, "node_modules", "stockfish", "bin", "stockfish-18-lite-single.js");
    const engine = spawn(process.execPath, [enginePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuffer = "";

    const onLine = line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed === "uciok") {
        engine.stdin.write("isready\n");
        return;
      }
      if (trimmed === "readyok") {
        stockfishProcess = engine;
        resolve(engine);
        return;
      }
    };

    engine.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        onLine(line);
      }
    });

    engine.stderr.on("data", chunk => {
      console.warn("[Stockfish] stderr:", chunk.toString().trim());
    });

    engine.on("exit", (code, signal) => {
      console.warn(`[Stockfish] engine exited code=${code} signal=${signal}`);
      if (stockfishProcess === engine) {
        stockfishProcess = null;
        stockfishReadyPromise = null;
      }
      if (code !== 0 && !stockfishProcess) {
        reject(new Error(`Stockfish process exited unexpectedly: ${code || signal}`));
      }
    });

    engine.on("error", error => {
      console.error("[Stockfish] engine error:", error);
      if (!stockfishProcess) {
        reject(error);
      }
    });

    engine.stdin.write("uci\n");
  });

  return stockfishReadyPromise;
}

function withAnalysisQueue(task) {
  analysisQueue = analysisQueue.then(() => task(), () => task());
  return analysisQueue;
}

function parseStockfishInfo(line, state) {
  const tokens = line.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "score" && tokens[i + 1]) {
      const scoreType = tokens[i + 1];
      const scoreValue = parseInt(tokens[i + 2], 10);
      if (scoreType === "cp") {
        state.evaluation = { type: "cp", value: scoreValue, depth: state.depth };
      } else if (scoreType === "mate") {
        state.evaluation = { type: "mate", value: scoreValue, depth: state.depth };
      }
    }
    if (tokens[i] === "depth" && tokens[i + 1]) {
      const parsed = parseInt(tokens[i + 1], 10);
      if (!Number.isNaN(parsed)) {
        state.depth = parsed;
      }
    }
  }
}

async function analyzeWithStockfish(fen, depth = 15, maxTimeMs = 4000) {
  const engine = await initStockfishEngine();

  return withAnalysisQueue(() => {
    return new Promise((resolve, reject) => {
      if (!stockfishProcess || stockfishProcess.killed) {
        return reject(new Error("Stockfish engine is not available"));
      }

      const state = {
        evaluation: { type: "cp", value: 0, depth },
        depth,
        bestMove: null,
        ponder: null
      };

      let timeoutId = null;
      let stdoutBuffer = "";
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        engine.stdout.removeListener("data", onStdoutData);
      };

      const finish = result => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const fail = error => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(error);
      };

      const onStdoutData = chunk => {
        stdoutBuffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;
          if (line.startsWith("info")) {
            parseStockfishInfo(line, state);
            continue;
          }
          if (line.startsWith("bestmove")) {
            const parts = line.split(/\s+/);
            state.bestMove = parts[1] || null;
            const ponderIndex = parts.indexOf("ponder");
            if (ponderIndex !== -1 && parts[ponderIndex + 1]) {
              state.ponder = parts[ponderIndex + 1];
            }
            if (!state.bestMove || state.bestMove === "(none)") {
              return fail(new Error("Stockfish failed to find a move"));
            }
            return finish({
              bestMove: state.bestMove,
              ponder: state.ponder,
              evaluation: state.evaluation,
              mate: state.evaluation.type === "mate" ? state.evaluation.value : null,
              depth: state.depth
            });
          }
        }
      };

      engine.stdout.on("data", onStdoutData);

      timeoutId = setTimeout(() => {
        engine.stdin.write("stop\n");
        fail(new Error("Stockfish analysis timed out"));
      }, maxTimeMs);

      engine.stdin.write("ucinewgame\n");
      engine.stdin.write(`position fen ${fen}\n`);
      engine.stdin.write(`go depth ${Math.min(Math.max(1, depth), 30)}\n`);
    });
  });
}

const PORT = process.env.PORT || 3000;

const userStore = new Map();
const gameStore = new Map();

function normalizePlanLimits(subscriptionTier, dailyLimit, weeklyLimit) {
  const tierDefaults = {
    free: { daily: 3, weekly: 10 },
    pro: { daily: 100, weekly: 500 },
    unlimited: { daily: 1000000, weekly: 10000000 }
  };
  const defaults = tierDefaults[subscriptionTier] || tierDefaults.free;
  const parsedDaily = Number.isFinite(Number(dailyLimit)) && Number(dailyLimit) >= 0 ? Number(dailyLimit) : defaults.daily;
  const parsedWeekly = Number.isFinite(Number(weeklyLimit)) && Number(weeklyLimit) >= 0 ? Number(weeklyLimit) : defaults.weekly;
  return { daily: parsedDaily, weekly: parsedWeekly };
}

function getAdminSecret() {
  return process.env.ADMIN_SECRET || "local-admin-secret";
}

function requireAdmin(req, res) {
  const adminSecret = req.body?.adminSecret || req.query?.adminSecret || req.headers.authorization?.replace(/^Bearer\s+/, "");
  if (adminSecret === getAdminSecret()) {
    return true;
  }
  res.status(401).json({ success: false, error: "Unauthorized" });
  return false;
}

function createToken(name = "graphdomination", email = "admin@antipiracy.dev", subscriptionTier = "free", dailyLimit, weeklyLimit) {
  const token = `chext_${crypto.randomUUID().replace(/-/g, "")}`;
  const tier = ["free", "pro", "unlimited"].includes(subscriptionTier) ? subscriptionTier : "free";
  const limits = normalizePlanLimits(tier, dailyLimit, weeklyLimit);
  const profile = {
    email,
    name,
    subscriptionTier: tier,
    usage: {
      daily: { used: 0, limit: limits.daily },
      weekly: { used: 0, limit: limits.weekly }
    }
  };
  userStore.set(token, profile);
  return token;
}

function getProfileFromRequest(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || typeof authHeader !== "string") return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return userStore.get(parts[1]) || null;
}

function evaluatePosition(chess) {
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      score += values[square.type] * (square.color === "w" ? 1 : -1);
    }
  }
  return score;
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ChessHelper.ai Local Server</title>
</head>
<body style="font-family:system-ui, sans-serif; line-height:1.6; padding:24px; background:#111; color:#eee;">
  <h1>ChessHelper.ai Local Server</h1>
  <p>This server provides the API required by the ChessHelper browser extension.</p>
  <ul>
    <li><strong>Analysis:</strong> <code>POST /api/analyze</code></li>
    <li><strong>Profile:</strong> <code>GET /api/me</code></li>
    <li><strong>Game tracking:</strong> <code>POST /api/games</code> and <code>PATCH /api/games</code></li>
    <li><strong>Checkout:</strong> <code>POST /api/stripe/create-checkout</code></li>
    <li><strong>Auth flow:</strong> <code>/register?callbackUrl=/extension/connect</code></li>
  </ul>
  <p>Configure the extension to use <code>http://localhost:${PORT}</code> as <code>APP_URL</code> and <code>API_URL</code>.</p>
</body>
</html>`);
});

app.get("/admin", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sampleUrl = `/admin?adminSecret=${encodeURIComponent(getAdminSecret())}`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ChessHelper.ai Admin</title>
  <style>body{font-family:system-ui, sans-serif;background:#111;color:#eee;padding:24px;}input,select{width:100%;margin:.5rem 0;padding:.5rem;border:1px solid #333;border-radius:6px;background:#121212;color:#eee;}button{padding:.75rem 1.25rem;border:none;border-radius:8px;background:#38bdf8;color:#000;font-weight:700;cursor:pointer;margin-top:.75rem;}label{display:block;margin:.75rem 0 .25rem;}textarea{width:100%;min-height:120px;margin:.5rem 0;padding:.75rem;border-radius:6px;border:1px solid #333;background:#0f172a;color:#eee;}</style>
</head>
<body>
  <h1>ChessHelper.ai Admin</h1>
  <p>Generate login tokens for testing. Use the same secret in <code>ADMIN_SECRET</code> or pass <code>?adminSecret=...</code>.</p>
  <form method="POST" action="/admin/token">
    <input type="hidden" name="adminSecret" value="${encodeURIComponent(getAdminSecret())}" />
    <label>Name</label>
    <input name="name" value="ChessHelper User" />
    <label>Email</label>
    <input name="email" value="user@example.com" />
    <label>Subscription Tier</label>
    <select name="subscriptionTier">
      <option value="free">free</option>
      <option value="pro">pro</option>
      <option value="unlimited">unlimited</option>
    </select>
    <label>Daily Usage Limit</label>
    <input name="dailyLimit" placeholder="leave blank for plan default" />
    <label>Weekly Usage Limit</label>
    <input name="weeklyLimit" placeholder="leave blank for plan default" />
    <button type="submit">Generate Token</button>
  </form>
  <p>API: <code>POST /admin/token</code></p>
  <p>Current admin URL: <code>${sampleUrl}</code></p>
  <p>Token list: <a href="/admin/tokens?adminSecret=${encodeURIComponent(getAdminSecret())}" style="color:#7dd3fc">/admin/tokens</a></p>
</body>
</html>`);
});

app.post("/admin/token", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, email, subscriptionTier, dailyLimit, weeklyLimit } = req.body || {};
  const token = createToken(name || "ChessHelper User", email || "user@example.com", subscriptionTier || "free", dailyLimit, weeklyLimit);
  return res.json({ success: true, token, profile: userStore.get(token) });
});

app.get("/admin/tokens", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tokens = Array.from(userStore.entries()).map(([token, profile]) => ({ token, profile }));
  return res.json({ success: true, tokens });
});

app.get("/register", (req, res) => {
  const callbackUrl = req.query.callbackUrl || "/extension/connect";
  const token = createToken();
  const connectUrl = `${callbackUrl}${callbackUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Connect ChessHelper Extension</title>
  <meta http-equiv="refresh" content="1; url=${connectUrl}" />
  <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui, sans-serif;padding:24px;}a{color:#38bdf8;}</style>
</head>
<body>
  <h1>ChessHelper.ai Signup</h1>
  <p>Your extension token has been created.</p>
  <p>Redirecting to <a href="${connectUrl}">extension connect page</a>...</p>
</body>
</html>`);
});

app.get("/extension/connect", (req, res) => {
  const token = req.query.token || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ChessHelper Extension Connect</title>
  ${token ? `<meta name="extension-token" content="${token}">` : ""}
  <style>body{font-family:system-ui, sans-serif;background:#111;color:#eee;padding:24px;line-height:1.6;}code{background:#0f172a;padding:2px 4px;border-radius:4px;}</style>
</head>
<body>
  <h1>ChessHelper.ai Extension Connected</h1>
  <p>${token ? "Your extension token is ready and the extension should capture it automatically." : "No token was provided. Please reload with a valid token."}</p>
  <p>Token: <code>${token || "none"}</code></p>
  <p>If the extension does not close automatically, you can close this tab manually.</p>
</body>
</html>`);
});

app.get("/pricing", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ChessHelper.ai Pricing</title>
  <style>body{font-family:system-ui, sans-serif;background:#111;color:#eee;padding:24px;}h1{margin-bottom:.5rem;}li{margin:.5rem 0;}</style>
</head>
<body>
  <h1>ChessHelper.ai Pricing</h1>
  <p>Local test server: checkout is simulated.</p>
  <ul>
    <li>Free: 3 games/day, 10 games/week</li>
    <li>Pro: Unlimited games, higher depth</li>
  </ul>
  <p>This server returns a simulated checkout URL for the extension.</p>
</body>
</html>`);
});

app.get("/api/me", (req, res) => {
  const profile = getProfileFromRequest(req);
  if (!profile) {
    return res.json({ authenticated: false });
  }
  return res.json({ authenticated: true, user: profile });
});

app.post("/api/analyze", async (req, res) => {
  const { fen, depth = 15 } = req.body || {};
  console.log("[Server] /api/analyze received", { fen: fen?.slice(0, 32), depth });
  if (!fen || typeof fen !== "string") {
    console.log("[Server] /api/analyze bad request");
    return res.status(400).json({ success: false, error: "Missing or invalid fen" });
  }

  let chess;
  try {
    chess = new Chess(fen);
  } catch (error) {
    return res.status(400).json({ success: false, error: "Invalid FEN" });
  }

  const moves = chess.moves();
  if (!moves.length) {
    return res.json({
      success: true,
      data: {
        success: true,
        analysis: {
          bestMove: null,
          evaluation: { type: "cp", value: 0, depth },
          mate: null,
          ponder: null,
          depth
        },
        meta: { cached: false }
      }
    });
  }

  try {
    console.log("[Server] /api/analyze starting Stockfish");
    const analysis = await analyzeWithStockfish(fen, depth, 5000);
    console.log("[Server] /api/analyze Stockfish result", analysis);
    return res.json({
      success: true,
      data: {
        success: true,
        analysis: {
          bestMove: analysis.bestMove,
          ponder: analysis.ponder,
          evaluation: analysis.evaluation,
          mate: analysis.mate,
          depth: analysis.depth
        },
        meta: {
          cached: false,
          fallbackUsed: false,
          alternativeUsed: false
        }
      }
    });
  } catch (error) {
    console.warn("[Server] Stockfish error:", error.message);
    const fallbackMove = moves[0];
    return res.json({
      success: true,
      data: {
        success: true,
        analysis: {
          bestMove: fallbackMove,
          ponder: null,
          evaluation: { type: "cp", value: 0, depth },
          mate: null,
          depth
        },
        meta: {
          cached: false,
          fallbackUsed: true,
          alternativeUsed: false
        }
      }
    });
  }
});

app.post("/api/games", (req, res) => {
  const profile = getProfileFromRequest(req);
  if (!profile) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }

  const { gameId, platform, timeControl, playerColor, opponentName, platformGameId } = req.body || {};
  if (!gameId) {
    return res.status(400).json({ success: false, error: "gameId is required" });
  }

  gameStore.set(gameId, {
    gameId,
    platform,
    timeControl,
    playerColor,
    opponentName,
    platformGameId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return res.json({ success: true });
});

app.patch("/api/games", (req, res) => {
  const profile = getProfileFromRequest(req);
  if (!profile) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }

  const { gameId, result, status, pgn, lastFen, timeControl } = req.body || {};
  if (!gameId) {
    return res.status(400).json({ success: false, error: "gameId is required" });
  }

  const existing = gameStore.get(gameId) || { gameId, createdAt: new Date().toISOString() };
  const updated = {
    ...existing,
    result: result || existing.result,
    status: status || existing.status,
    pgn: pgn || existing.pgn,
    lastFen: lastFen || existing.lastFen,
    timeControl: timeControl || existing.timeControl,
    updatedAt: new Date().toISOString()
  };
  gameStore.set(gameId, updated);
  return res.json({ success: true });
});

app.post("/api/stripe/create-checkout", (req, res) => {
  const profile = getProfileFromRequest(req);
  if (!profile) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }
  const { priceId } = req.body || {};
  if (!priceId) {
    return res.status(400).json({ success: false, error: "priceId is required" });
  }
  const sessionId = crypto.randomUUID();
  return res.json({
    success: true,
    url: `https://example.com/checkout?session=${sessionId}&priceId=${encodeURIComponent(priceId)}`
  });
});

app.post("/api/extension/dom-health", (req, res) => {
  return res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`ChessHelper.ai local server running at http://localhost:${PORT}`);
});
