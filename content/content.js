/**
 * Content Script - Board Detection & FEN Extraction
 *
 * This script detects the chess board on chess.com and lichess.org pages,
 * extracts the current position as FEN notation, and communicates with
 * the service worker for ChessHelper AI analysis.
 */
// Debug mode - set to true to enable console logging (shared across content scripts)
var _D = true;

var _log = _D ? console.log.bind(console) : () => {};

var _warn = _D ? console.warn.bind(console) : () => {};

var _err = _D ? console.error.bind(console) : () => {};

var _info = _D ? console.info.bind(console) : () => {};

// Platform detection: 'chess.com' or 'lichess'
let currentPlatform = window.location.hostname.includes("lichess.org") ? "lichess" : "chess.com";

window._chPlatform = currentPlatform;

// State management
let currentFen = null;

let extensionEnabled = true;

let isAnalysisEnabled = true;

let analysisDepth = 15;

let autoplayEnabled = false;

let autoplayDelay = 1e3;

let autoplayDelayMin = 500;

let autoplayDelayMax = 2e3;

let autoplayVariationEnabled = true;

let isAnalyzing = false;

let boardObserver = null;

let pageObserver = null;

let debounceTimer = null;

let autoplayTimer = null;

let lastAutoplayedFen = null;

let autoplayExpectedTurn = null;

 // opponent's color after autoplay executes
let autoplayMoveCount = null;

 // move count at moment autoplay executed
let pollingInterval = null;

let cachedBoard = null;

let isSettingUp = false;

 // Prevent duplicate setup calls
// Request tracking to prevent race conditions with rapid moves
let currentRequestId = 0;

let pendingRequestId = null;

let lastApiPosition = null;

 // position part of FEN currently being analyzed
let lastPolledPosition = null;

 // position from previous poll (for stability check)
// Game ID for worker affinity (same worker handles same game)
let currentGameId = null;

// Time control detection cache (reset per game)
let detectedTimeControl = null;

// Antidetect state
let antidetectEnabled = false;

let antidetectIntervalMin = 5;

let antidetectIntervalMax = 6;

let antidetectMoveCounter = 0;

let antidetectNextWeakAt = 0;

let antidetectIsWeakMove = false;

// Game state detection
let isGameOver = false;

let gameOverReason = null;

let gameEndWinner = null;

 // 'white' or 'black' — set from FEN analysis (checkmate)
let cachedGameResult = null;

 // Cache result immediately when game-over UI is detected
let detectedGameOverTexts = new Set;

 // Texts of game-over elements already detected (prevents stale modal re-detection)
// Game tracking (for server-side game history)
let gameTrackingSent = false;

 // Has GAME_STARTED been sent for current game?
// URL monitoring for game detection
let lastGameUrl = null;

// Debounce delay for rapid position changes (ms)
const DEBOUNCE_DELAY = 150;

// Rate limit cooldown — prevents infinite retry loops when API rate limits
let rateLimitedUntil = 0;

// Last analysis result (for autoplay toggle using existing move)
let lastBestMove = null;

let lastBestMoveFen = null;

// Grace period after new game detection — suppresses false game-end detection
// from lingering chess.com game-over modals during game transitions
let newGameGracePeriodUntil = 0;

// AbortController for cleaning up event listeners
let eventListenerController = null;

// Piece mapping from chess.com class to FEN character
const PIECE_MAP = {
  wp: "P",
  wn: "N",
  wb: "B",
  wr: "R",
  wq: "Q",
  wk: "K",
  bp: "p",
  bn: "n",
  bb: "b",
  br: "r",
  bq: "q",
  bk: "k"
};

// Lichess piece class to FEN character mapping
const LICHESS_PIECE_MAP = {
  "white king": "K",
  "white queen": "Q",
  "white rook": "R",
  "white bishop": "B",
  "white knight": "N",
  "white pawn": "P",
  "black king": "k",
  "black queen": "q",
  "black rook": "r",
  "black bishop": "b",
  "black knight": "n",
  "black pawn": "p"
};

// ── Centralized Selector Registry ──────────────────────────────────────────
// Update here when chess.com or lichess.org change their DOM structure.
// All DOM queries throughout this file reference this registry.
const SELECTORS = {
  "chess.com": {
    board: [ "wc-chess-board", "chess-board", ".board" ],
    pieces: ".piece",
    pieceSquarePrefix: "square-",
    moveList: [ "wc-simple-move-list", "wc-move-list", ".move-list", "vertical-move-list", '[class*="move-list"]', ".play-controller-moveList", ".play-controller-moves-container", ".moves-wrapper", ".play-controller-moves" ],
    moveNodes: [ ".move-san-san", ".move-san-component", ".node", ".move", "[data-ply]", '[class*="node"]', '[class*="move-san"]' ],
    clockActive: '[class*="clock"][class*="turn"], [class*="clock"][class*="active"], .clock-bottom.clock-player-turn, .clock-top.clock-player-turn',
    gameOver: [ ".game-over-modal", '[class*="game-over"]', ".modal-game-over", '.board-modal-container [class*="game-result"]', ".board-modal-container-container", ".board-modal-container" ],
    promotionDialog: [ ".promotion-window", ".promotion-menu", ".promotion-area", '[class*="promotion-"]', '[class*="Promotion"]', 'div[data-cy="promotion-window"]', ".board-modal-container" ],
    promotionFallbackContainer: [ '[class*="promotion"]', ".promotion-window", ".promotion-menu", ".board-modal-container" ],
    timeControl: [ ".time-selector-next-component button", '[class*="time-selector"] button' ],
    timeControlInfo: [ '[data-cy="game-info-time"]', ".game-info-time", '[class*="time-control"]', '[class*="TimeControl"]', '[class*="game-info"] [class*="time"]', ".header-time-control", ".game-over-header-time" ],
    clockDisplay: [ ".clock-time-monospace", ".clock-component", '[class*="clock"] [class*="time"]' ],
    gameCategory: [ '[class*="game-type"]', '[class*="GameType"]', '[class*="rating-category"]' ],
    gameResult: [ ".game-over-header-component", ".game-over-modal-content", ".game-over-player-component", ".game-over-modal", '[class*="game-over"]', ".modal-game-over", ".board-modal-container-container", ".board-modal-container", ".result-wrap" ],
    playerTop: '.board-player-default-top .user-tagline-username, [class*="playerTop"] [class*="username"], [class*="player-top"] [class*="user"]',
    playerBottom: '.board-player-default-bottom .user-tagline-username, [class*="playerBottom"] [class*="username"], [class*="player-bottom"] [class*="user"]'
  },
  lichess: {
    board: [ "cg-board" ],
    pieces: "piece",
    boardWrapper: ".cg-wrap",
    flippedClass: "orientation-black",
    moveList: [ "l4x", ".tview2", ".moves", "rm6 l4x" ],
    moveNodes: [ "kwdb", "move", "san", ".move" ],
    clockActive: ".rclock.running",
    clockWhiteClass: "rclock-white",
    clockDisplay: [ ".rclock .time" ],
    gameOver: [ ".status", ".result-wrap .status" ],
    promotionElement: "square",
    timeSetup: [ ".setup", ".game__meta__infos .header .setup" ],
    players: ".ruser .username, .ruser-top name, .ruser-bottom name, .game__meta .user-link",
    animationSkipClasses: [ "ghost", "fading" ]
  }
};

/**
 * Query the first matching element from a selector or array of selectors
 * @param {string|string[]} selectors - Single selector or array of fallback selectors
 * @param {Element|Document} root - Root element to search within
 * @returns {Element|null} First matching element or null
 */ function queryFirst(selectors, root = document) {
  const list = Array.isArray(selectors) ? selectors : [ selectors ];
  for (const s of list) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch (e) {
      // Invalid selector, skip
    }
  }
  return null;
}

/**
 * Get selectors for the current platform
 * @returns {Object} The selector config for the current platform
 */ function sel() {
  return SELECTORS[currentPlatform];
}

// Selector categories for diagnostics:
// - 'core': Must be present when a game is active (board, pieces)
// - 'game': Present during active game but may take a moment to load (move list)
// - 'optional': May be absent depending on game mode (computer, puzzles, analysis) — never flagged as broken
// - 'event': Only present during specific events (game-over, promotion) — never flagged as broken
const SELECTOR_CATEGORIES = {
  board: "core",
  pieces: "core",
  moveList: "game",
  moveNodes: "game",
  clockActive: "optional",
  clockDisplay: "optional",
  playerTop: "optional",
  playerBottom: "optional",
  players: "optional",
  timeSetup: "optional",
  timeControl: "optional",
  timeControlInfo: "optional",
  gameCategory: "optional",
  gameOver: "event",
  gameResult: "event",
  promotionDialog: "event",
  promotionFallbackContainer: "event",
  promotionElement: "event"
};

/**
 * Run diagnostics on all selectors in the registry for the current platform.
 * Tests which selectors match elements and reports broken features.
 * @returns {Object} Diagnostics report keyed by feature name
 */ function runSelectorDiagnostics() {
  const platform = currentPlatform;
  const sels = SELECTORS[platform];
  const results = {};
  for (const key of Object.keys(SELECTOR_CATEGORIES)) {
    if (!(key in sels)) continue;
    const value = sels[key];
    const selectors = Array.isArray(value) ? value : [ value ];
    const featureResults = [];
    let anyFound = false;
    for (const s of selectors) {
      try {
        const found = !!document.querySelector(s);
        featureResults.push({
          selector: s,
          found: found
        });
        if (found) anyFound = true;
      } catch (e) {
        featureResults.push({
          selector: s,
          found: false,
          error: true
        });
      }
    }
    const category = SELECTOR_CATEGORIES[key];
    results[key] = {
      selectors: featureResults,
      working: anyFound,
      category: category
    };
  }
  return results;
}

/**
 * Log selector diagnostics and send to background for popup display.
 * Called after pieces have loaded so game-active selectors are present.
 * @param {boolean} isRetry - Whether this is a deferred re-check
 */ function reportSelectorDiagnostics(isRetry = false) {
  const diag = runSelectorDiagnostics();
  // Only flag core and game selectors as broken — event selectors (game-over,
  // promotion) and optional selectors (clocks, players, time control) may be
  // absent depending on the game mode (computer, puzzles, analysis).
    const ignoredCategories = [ "event", "optional" ];
  const broken = Object.entries(diag).filter(([, v]) => !v.working && !ignoredCategories.includes(v.category)).map(([k]) => k);
  const working = Object.entries(diag).filter(([, v]) => v.working).map(([k]) => k);
  // Chess.com lazy-loads the move list component after the board/pieces.
  // If moveList or moveNodes are broken on first check, schedule a re-check
  // to avoid false-positive warnings during normal page load.
    const lateLoadFeatures = [ "moveList", "moveNodes" ];
  const hasLateLoadBroken = broken.some(k => lateLoadFeatures.includes(k));
  if (!isRetry && hasLateLoadBroken) {
    _log("[Chess Helper] Move list not yet in DOM — will re-check in 5s");
    setTimeout(() => reportSelectorDiagnostics(true), 5e3);
    return;
  }
  if (broken.length > 0) {
    _warn("[Chess Helper] Selector diagnostics — BROKEN features:", broken.join(", "));
    _warn("[Chess Helper] Broken selector details:", JSON.stringify(Object.fromEntries(Object.entries(diag).filter(([, v]) => !v.working && !ignoredCategories.includes(v.category))), null, 2));
  }
  if (working.length > 0) {
    _log("[Chess Helper] Selector diagnostics — working features:", working.join(", "));
  }
  // Send to background so popup can display health status
    safeSendMessage({
    type: "SELECTOR_DIAGNOSTICS",
    platform: currentPlatform,
    results: diag
  });
}

/**
 * Find the chess board element on the page
 * @param {boolean} useCache - Whether to use cached board
 * @returns {Element|null} The board element or null if not found
 */ function findBoard(useCache = true) {
  // Return cached board if available and still in DOM
  if (useCache && cachedBoard && document.contains(cachedBoard)) {
    return cachedBoard;
  }
  // Search for board using centralized selector registry
    for (const selector of sel().board) {
    const board = document.querySelector(selector);
    if (board) {
      cachedBoard = board;
      return board;
    }
  }
  cachedBoard = null;
  return null;
}

/**
 * Detect if the board is flipped (playing as black)
 * @param {Element} board - The board element
 * @returns {boolean} True if board is flipped
 */ function isBoardFlipped(board) {
  // Lichess: check board wrapper parent for orientation class
  if (currentPlatform === "lichess") {
    const wrapperSel = sel().boardWrapper;
    const cgWrap = board.closest(wrapperSel) || board.parentElement?.closest(wrapperSel);
    if (cgWrap) {
      return cgWrap.classList.contains(sel().flippedClass);
    }
    return false;
  }
  // Chess.com uses 'flipped' class on the board when playing as black
    if (board.classList.contains("flipped")) {
    return true;
  }
  // Alternative: check for 'board-flipped' attribute or data attribute
    if (board.hasAttribute("flipped") || board.dataset.flipped === "true") {
    return true;
  }
  // Check wc-chess-board custom element orientation
    if (board.tagName.toLowerCase() === "wc-chess-board") {
    const orientation = board.getAttribute("orientation");
    if (orientation === "black") {
      return true;
    }
  }
  return false;
}

/**
 * Parse a chess.com piece element to get piece type and square
 * @param {Element} pieceElement - The piece DOM element
 * @returns {Object|null} Object with piece and square, or null if invalid
 */ function parsePieceElement(pieceElement) {
  const classes = pieceElement.className.split(" ");
  let pieceType = null;
  let squareNum = null;
  for (const cls of classes) {
    // Piece type class: 'wp', 'bn', 'wr', etc.
    if (/^[wb][pnbrqk]$/.test(cls)) {
      pieceType = cls;
    }
    // Square class: 'square-XY' where X is file (1-8), Y is rank (1-8)
        const squareMatch = cls.match(/^square-(\d)(\d)$/);
    if (squareMatch) {
      squareNum = {
        file: parseInt(squareMatch[1], 10),
        rank: parseInt(squareMatch[2], 10)
      };
    }
  }
  if (!pieceType || !squareNum) {
    return null;
  }
  return {
    piece: PIECE_MAP[pieceType],
    file: squareNum.file,
    rank: squareNum.rank
  };
}

/**
 * Parse a Lichess piece element to get piece type and square
 * Lichess pieces use class names like "white pawn" and CSS transforms for position
 * @param {Element} pieceElement - The piece DOM element
 * @param {number} squareSize - Size of one square in pixels
 * @param {boolean} isFlipped - Whether the board is flipped (orientation-black)
 * @returns {Object|null} Object with piece and square, or null if invalid
 */ function parseLichessPieceElement(pieceElement, squareSize, isFlipped) {
  // Get piece type from class list entries (e.g., "white", "pawn", "black", "rook")
  // Lichess dynamically adds classes like "anim", "fading" during animations,
  // so we must parse color and type individually instead of exact className match
  const classes = pieceElement.classList;
  let color = null, type = null;
  for (const cls of classes) {
    if (cls === "white" || cls === "black") color = cls; else if (cls === "king" || cls === "queen" || cls === "rook" || cls === "bishop" || cls === "knight" || cls === "pawn") type = cls;
  }
  if (!color || !type) return null;
  const piece = LICHESS_PIECE_MAP[`${color} ${type}`];
  if (!piece) return null;
  // Get position from CSS transform: translate(Xpx, Ypx)
    const style = pieceElement.style.transform || "";
  const match = style.match(/translate\(([0-9.]+)px,\s*([0-9.]+)px\)/);
  if (!match) return null;
  const x = parseFloat(match[1]);
  const y = parseFloat(match[2]);
  let file, rank;
  if (isFlipped) {
    // orientation-black: X=0 is h-file(8), Y=0 is rank 1
    file = 8 - Math.round(x / squareSize);
    rank = Math.round(y / squareSize) + 1;
  } else {
    // orientation-white: X=0 is a-file(1), Y=0 is rank 8
    file = Math.round(x / squareSize) + 1;
    rank = 8 - Math.round(y / squareSize);
  }
  if (file < 1 || file > 8 || rank < 1 || rank > 8) return null;
  return {
    piece: piece,
    file: file,
    rank: rank
  };
}

/**
 * Convert board state to FEN position string (only piece placement)
 * @param {Array} boardState - 8x8 array of piece characters
 * @returns {string} FEN position string
 */ function boardToFenPosition(boardState) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let emptyCount = 0;
    for (let file = 1; file <= 8; file++) {
      const piece = boardState[rank - 1][file - 1];
      if (piece) {
        if (emptyCount > 0) {
          row += emptyCount;
          emptyCount = 0;
        }
        row += piece;
      } else {
        emptyCount++;
      }
    }
    if (emptyCount > 0) {
      row += emptyCount;
    }
    rows.push(row);
  }
  return rows.join("/");
}

/**
 * Detect whose turn it is from the game UI
 * @returns {string} 'w' for white, 'b' for black
 */ function detectTurn() {
  // Both platforms: clock updates instantly when a move is made, while the
  // move list DOM lags behind. Use clock as primary signal to avoid stale
  // turn detection that causes unnecessary API calls.
  if (currentPlatform === "lichess") {
    const runningClock = document.querySelector(sel().clockActive);
    if (runningClock) {
      return runningClock.classList.contains(sel().clockWhiteClass) ? "w" : "b";
    }
  } else {
    const clockRunning = document.querySelector(sel().clockActive);
    if (clockRunning) {
      const board = findBoard();
      if (board) {
        const flipped = isBoardFlipped(board);
        const isBottom = clockRunning.classList.contains("clock-bottom") || clockRunning.closest('[class*="bottom"]');
        return isBottom ? flipped ? "b" : "w" : flipped ? "w" : "b";
      }
    }
  }
  // Move list method (fallback for both platforms when clock not available)
    const moves = parseMoveList();
  if (moves.length > 0) {
    // Odd number of moves = white just moved = black's turn
    // Even number of moves = black just moved = white's turn
    return moves.length % 2 === 1 ? "b" : "w";
  }
  // Default: white's turn (game start)
    return "w";
}

/**
 * Detect castling rights from move history and current position
 * Tracks king/rook movements to accurately determine forfeited rights
 * @param {string} fenPosition - The FEN position string (piece placement only)
 * @returns {string} Castling availability string (e.g., 'KQkq', 'Kq', '-')
 */ function detectCastlingRights(fenPosition) {
  const moves = parseMoveList();
  // Start with full castling rights
    let whiteKingside = true;
  let whiteQueenside = true;
  let blackKingside = true;
  let blackQueenside = true;
  // Check move history for king/rook movements or castling
    for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const isWhiteMove = i % 2 === 0;
    // Castling means that side can't castle again
        if (move.isKingsideCastle || move.isQueensideCastle) {
      if (isWhiteMove) {
        whiteKingside = false;
        whiteQueenside = false;
      } else {
        blackKingside = false;
        blackQueenside = false;
      }
      continue;
    }
    // King move (K prefix) forfeits all castling rights for that side
        if (move.notation.startsWith("K")) {
      if (isWhiteMove) {
        whiteKingside = false;
        whiteQueenside = false;
      } else {
        blackKingside = false;
        blackQueenside = false;
      }
    }
    // Rook moves - check source square from notation if available
        if (move.notation.startsWith("R")) {
      const notation = move.notation;
      // R from a-file loses queenside, from h-file loses kingside
            if (notation.includes("a1") || isWhiteMove && notation.match(/^Ra[^8]/)) {
        whiteQueenside = false;
      }
      if (notation.includes("h1") || isWhiteMove && notation.match(/^Rh[^8]/)) {
        whiteKingside = false;
      }
      if (notation.includes("a8") || !isWhiteMove && notation.match(/^Ra/)) {
        blackQueenside = false;
      }
      if (notation.includes("h8") || !isWhiteMove && notation.match(/^Rh/)) {
        blackKingside = false;
      }
    }
  }
  // Also verify pieces are still in place (handles captures)
    const rows = fenPosition.split("/");
  const whiteBackRank = expandFenRow(rows[7] || "");
  const blackBackRank = expandFenRow(rows[0] || "");
  // White king must be on e1 for castling
    if (whiteBackRank[4] !== "K") {
    whiteKingside = false;
    whiteQueenside = false;
  }
  // White rooks must be in place
    if (whiteBackRank[7] !== "R") whiteKingside = false;
  if (whiteBackRank[0] !== "R") whiteQueenside = false;
  // Black king must be on e8
    if (blackBackRank[4] !== "k") {
    blackKingside = false;
    blackQueenside = false;
  }
  // Black rooks must be in place
    if (blackBackRank[7] !== "r") blackKingside = false;
  if (blackBackRank[0] !== "r") blackQueenside = false;
  // Build castling string
    let castling = "";
  if (whiteKingside) castling += "K";
  if (whiteQueenside) castling += "Q";
  if (blackKingside) castling += "k";
  if (blackQueenside) castling += "q";
  return castling || "-";
}

/**
 * Detect en passant square from the last move
 * @param {string} turn - Current turn ('w' or 'b')
 * @returns {string} En passant square in algebraic notation or '-'
 */ function detectEnPassant(turn) {
  const moves = parseMoveList();
  if (moves.length === 0) return "-";
  const lastMove = moves[moves.length - 1];
  // En passant only possible after opponent's pawn moved 2 squares
  // If it's white's turn, check if black just made a 2-square pawn move
  // If it's black's turn, check if white just made a 2-square pawn move
    if (!lastMove.isPawnMove) return "-";
  const notation = lastMove.notation;
  // Try to detect 2-square pawn advance from notation
  // Common formats: "e4", "d5", "e2-e4", "d7d5"
  // Check for explicit 2-square move (e2-e4 format)
    const explicitMatch = notation.match(/^([a-h])([27])-?\1([45])$/);
  if (explicitMatch) {
    const file = explicitMatch[1];
    const fromRank = parseInt(explicitMatch[2]);
    const toRank = parseInt(explicitMatch[3]);
    if (Math.abs(toRank - fromRank) === 2) {
      // En passant square is the square "jumped over"
      const epRank = fromRank === 2 ? 3 : 6;
      return file + epRank;
    }
  }
  // Check for simple notation that could be 2-square advance
  // "e4" by white (from e2) or "d5" by black (from d7)
    const simpleMatch = notation.match(/^([a-h])([45])$/);
  if (simpleMatch) {
    const file = simpleMatch[1];
    const toRank = parseInt(simpleMatch[2]);
    // White's 2-square advance ends on rank 4
    // Black's 2-square advance ends on rank 5
        if (turn === "w" && toRank === 5) {
      // Black just moved pawn to rank 5 (from 7), en passant on rank 6
      return file + "6";
    }
    if (turn === "b" && toRank === 4) {
      // White just moved pawn to rank 4 (from 2), en passant on rank 3
      return file + "3";
    }
  }
  return "-";
}

/**
 * Expand a FEN row string to an array of 8 squares
 * @param {string} row - FEN row string
 * @returns {Array} Array of 8 pieces or null for empty squares
 */ function expandFenRow(row) {
  const expanded = [];
  for (const char of row) {
    if (/\d/.test(char)) {
      const emptyCount = parseInt(char, 10);
      for (let i = 0; i < emptyCount; i++) {
        expanded.push(null);
      }
    } else {
      expanded.push(char);
    }
  }
  return expanded;
}

// Cache for parsed move list to avoid repeated DOM queries
let cachedMoveList = null;

let cachedMoveListLength = -1;

/**
 * Parse moves from Chess.com move list (with caching)
 * @param {boolean} forceRefresh - Force re-parsing even if cached
 * @returns {Array} Array of move objects with notation and metadata
 */ function parseMoveList(forceRefresh = false) {
  let moveListElement = null;
  let nodes = [];
  // Find move list container using registry selectors
    moveListElement = queryFirst(sel().moveList);
  if (moveListElement) {
    // Try known tag/class selectors for move nodes (fast path)
    for (const nodeSel of sel().moveNodes) {
      try {
        nodes = moveListElement.querySelectorAll(nodeSel);
        if (nodes.length > 0) break;
      } catch (e) {/* invalid selector, skip */}
    }
    // Regex fallback: scan leaf elements for chess notation patterns.
    // This is critical for Lichess where obfuscated tag names (l4x, kwdb)
    // change between deployments. The regex matches regardless of tag names.
        if (nodes.length === 0) {
      if (currentPlatform === "lichess") {
        _warn("[Chess Helper] Known Lichess move node selectors failed — using notation regex fallback. Update SELECTORS.lichess.moveNodes.");
      }
      nodes = Array.from(moveListElement.querySelectorAll("*")).filter(el => {
        if (el.children.length > 0) return false;
 // Only leaf elements
                const text = el.textContent.trim();
        return /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]([+#]|=[QRBN])?$/.test(text) || /^O-O(-O)?[+#]?$/.test(text);
      });
    }
  } else {
    // Container selectors failed — scan the sidebar for chess notation elements.
    // Chess.com and Lichess both change their DOM structure frequently, so this
    // regex-based fallback works regardless of class/tag name changes.
    const fallbackRoot = currentPlatform === "lichess" ? document : document.querySelector(".board-layout-sidebar") || document.querySelector("#board-layout-sidebar") || document;
    if (fallbackRoot) {
      const candidates = fallbackRoot.querySelectorAll("div, section, main, wc-simple-move-list, wc-move-list");
      for (const candidate of candidates) {
        const leafNodes = Array.from(candidate.querySelectorAll("*")).filter(el => {
          if (el.children.length > 0) return false;
          const text = el.textContent.trim();
          return /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]([+#]|=[QRBN])?$/.test(text) || /^O-O(-O)?[+#]?$/.test(text);
        });
        // A real move list will have multiple chess notation elements
                if (leafNodes.length >= 2) {
          moveListElement = candidate;
          nodes = leafNodes;
          break;
        }
      }
    }
  }
  if (!moveListElement) {
    cachedMoveList = [];
    cachedMoveListLength = 0;
    return [];
  }
  // Use cache if move count hasn't changed (quick check)
    if (!forceRefresh && cachedMoveList && nodes.length === cachedMoveListLength) {
    return cachedMoveList;
  }
  const moves = [];
  for (const node of nodes) {
    const text = node.textContent.trim();
    // Skip move numbers like "1." "2." or empty nodes
        if (!text || /^\d+\.?$/.test(text)) continue;
    // Skip if it's just whitespace or ellipsis
        if (/^[\s…\.]+$/.test(text)) continue;
    moves.push({
      notation: text,
      isCastle: text === "O-O" || text === "O-O-O" || text === "0-0" || text === "0-0-0",
      isKingsideCastle: text === "O-O" || text === "0-0",
      isQueensideCastle: text === "O-O-O" || text === "0-0-0",
      isCapture: text.includes("x"),
      isPawnMove: /^[a-h]/.test(text) && !/^[KQRBN]/.test(text)
    });
  }
  // Update cache
    cachedMoveList = moves;
  cachedMoveListLength = nodes.length;
  return moves;
}

/**
 * Clear the move list cache (call when position changes)
 */ function clearMoveListCache() {
  cachedMoveList = null;
  cachedMoveListLength = -1;
}

/**
 * Extract the current board position as FEN
 * @returns {string|null} FEN string or null if board not found
 */ function extractFen() {
  const board = findBoard();
  if (!board) {
    return null;
  }
  // Initialize empty 8x8 board
    const boardState = Array(8).fill(null).map(() => Array(8).fill(null));
  if (currentPlatform === "lichess") {
    // Lichess: pieces are <piece> tag elements inside cg-board
    const pieces = board.querySelectorAll(sel().pieces);
    if (pieces.length === 0) return null;
    // Get board size for coordinate calculation
        const container = board.closest("cg-container") || board;
    const boardWidth = container.clientWidth || container.getBoundingClientRect().width;
    const squareSize = boardWidth / 8;
    const isFlipped = isBoardFlipped(board);
    let parsedCount = 0;
    for (const pieceEl of pieces) {
      // Skip ghost/dragged/fading pieces (ghost = drag preview, fading = captured piece)
      const skipClasses = sel().animationSkipClasses || [];
      if (pieceEl.cgDragging || skipClasses.some(c => pieceEl.classList.contains(c))) continue;
      const parsed = parseLichessPieceElement(pieceEl, squareSize, isFlipped);
      if (parsed) {
        boardState[parsed.rank - 1][parsed.file - 1] = parsed.piece;
        parsedCount++;
      }
    }
    // Sanity check: a valid position must have at least 2 kings.
    // If we parsed very few pieces, the board is likely mid-animation.
        if (parsedCount < 2) return null;
  } else {
    // Chess.com: access shadow root if it exists (wc-chess-board uses Shadow DOM)
    const root = board.shadowRoot || board;
    const pieces = root.querySelectorAll(sel().pieces);
    if (pieces.length === 0) return null;
    for (const pieceEl of pieces) {
      const parsed = parsePieceElement(pieceEl);
      if (parsed) {
        boardState[parsed.rank - 1][parsed.file - 1] = parsed.piece;
      }
    }
  }
  // Convert to FEN position
    const fenPosition = boardToFenPosition(boardState);
  // Detect turn first (needed for en passant)
    const turn = detectTurn();
  // Detect castling rights (now uses move history)
    const castling = detectCastlingRights(fenPosition);
  // Detect en passant from last move
    const enPassant = detectEnPassant(turn);
  // Calculate move counts from move list
    const moves = parseMoveList();
  const halfmove = "0";
 // TODO: Track captures/pawn moves for accurate count
    const fullmove = Math.max(1, Math.floor(moves.length / 2) + 1);
  // Construct full FEN
    const fen = `${fenPosition} ${turn} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
  return fen;
}

/**
 * Validate FEN using chess.js
 * @param {string} fen - FEN string to validate
 * @returns {boolean} True if valid
 */ function isValidFen(fen) {
  try {
    // Chess.js is loaded via manifest content scripts
    if (typeof Chess !== "undefined") {
      const chess = new Chess;
      return chess.load(fen);
    }
    // If chess.js not available, do basic validation
        const parts = fen.split(" ");
    return parts.length === 6;
  } catch (e) {
    return false;
  }
}

/**
 * Detect game end state (checkmate, stalemate, draw)
 * @param {string} fen - FEN string to check
 * @returns {Object} Game state with isOver and reason
 */ function detectGameEndState(fen) {
  try {
    if (typeof Chess === "undefined") {
      return {
        isOver: false,
        reason: null
      };
    }
    const chess = new Chess;
    if (!chess.load(fen)) {
      return {
        isOver: false,
        reason: null
      };
    }
    // Check for checkmate
        if (chess.in_checkmate()) {
      const loser = chess.turn();
      return {
        isOver: true,
        reason: "checkmate",
        winner: loser === "w" ? "black" : "white"
      };
    }
    // Check for stalemate
        if (chess.in_stalemate()) {
      return {
        isOver: true,
        reason: "stalemate"
      };
    }
    // Check for draw conditions
        if (chess.in_draw()) {
      // Determine the specific draw reason
      if (chess.insufficient_material()) {
        return {
          isOver: true,
          reason: "insufficient_material"
        };
      }
      if (chess.in_threefold_repetition()) {
        return {
          isOver: true,
          reason: "threefold_repetition"
        };
      }
      // 50-move rule or other draw
            return {
        isOver: true,
        reason: "draw"
      };
    }
    return {
      isOver: false,
      reason: null
    };
  } catch (e) {
    return {
      isOver: false,
      reason: null
    };
  }
}

/**
 * Detect game end state from chess.com UI elements
 * @returns {Object|null} Game state from UI or null if not detected
 */ function detectGameEndFromUI() {
  if (currentPlatform === "lichess") {
    // Lichess: game status shown in status element
    const status = queryFirst(sel().gameOver);
    if (status) {
      const text = status.textContent.toLowerCase();
      if (text.includes("checkmate")) return {
        isOver: true,
        reason: "checkmate"
      };
      if (text.includes("stalemate")) return {
        isOver: true,
        reason: "stalemate"
      };
      if (text.includes("draw") || text.includes("drawn") || text.includes("fifty move")) return {
        isOver: true,
        reason: "draw"
      };
      if (text.includes("resign")) return {
        isOver: true,
        reason: "resignation"
      };
      // Timeout: "White time out", "Black time out", or "X ran out of time"
            if (text.includes("time out") || text.includes("timeout") || text.includes("ran out of time")) return {
        isOver: true,
        reason: "timeout"
      };
      // Inactivity: "White didn't move", "Black didn't move"
            if (text.includes("didn't move") || text.includes("did not move")) return {
        isOver: true,
        reason: "timeout"
      };
      if (text.includes("left the game")) return {
        isOver: true,
        reason: "opponent_left"
      };
      if (text.includes("abort")) return {
        isOver: true,
        reason: "aborted"
      };
      if (text.includes("victorious") || text.includes("wins")) return {
        isOver: true,
        reason: "ended"
      };
    }
    return null;
  }
  // Chess.com game-over selectors from centralized registry
    const gameOverSelectors = sel().gameOver;
  let foundAnyElement = false;
  for (const selector of gameOverSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      // Skip elements that are hidden — chess.com keeps game-over modals in DOM
      // but may hide them via display:none, visibility:hidden, opacity:0, or zero size
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      // Check if the element is actually visible to the user (on top of the board).
      // Stale game-over modals from game 1 may persist in the DOM during game 2
      // but get covered by the new game's board. elementFromPoint returns the
      // topmost element at the modal's center — if it's NOT the modal (or a child),
      // the modal is covered/stale and should be skipped.
            const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX > 0 && centerY > 0) {
        const topEl = document.elementFromPoint(centerX, centerY);
        if (topEl && topEl !== element && !element.contains(topEl) && !topEl.contains(element)) {
          continue;
 // Element is covered by something else — stale modal
                }
      }
      foundAnyElement = true;
      const text = element.textContent.toLowerCase();
      // Skip if this is just the board container without any game-over content
            if (selector === ".board-modal-container" && !text.trim()) continue;
      // Skip stale game-over modals from a previous game (text dedup fallback).
      // Handles cases where the stale modal passes the elementFromPoint check
      // (e.g., z-indexed above the board but visually irrelevant).
            if (detectedGameOverTexts.has(text)) continue;
      let reason = "ended";
      if (text.includes("checkmate")) {
        reason = "checkmate";
      } else if (text.includes("stalemate")) {
        reason = "stalemate";
      } else if (text.includes("draw") || text.includes("drawn") || text.includes("repetition") || text.includes("insufficient") || text.includes("agreement")) {
        reason = "draw";
      } else if (text.includes("resigned") || text.includes("resigns") || text.includes("resignation")) {
        reason = "resignation";
      } else if (text.includes("timeout") || text.includes("on time") || text.includes("out of time") || text.includes("time out") || text.includes("ran out")) {
        reason = "timeout";
      } else if (text.includes("abandoned") || text.includes("abort")) {
        reason = "abandoned";
      }
      // Require actual game-over keywords in the text for ALL selectors.
            if (reason === "ended") {
        continue;
      }
      // Snapshot ALL game-over elements' text to prevent cascade detection
      // (multiple selectors matching different stale elements from the same game)
            for (const s of gameOverSelectors) {
        const el = document.querySelector(s);
        if (el) {
          detectedGameOverTexts.add(el.textContent.toLowerCase());
        }
      }
      // Cache the result immediately while the modal is still visible.
            if (!cachedGameResult) {
        cachedGameResult = detectGameResultFromElement(element);
        if (cachedGameResult) {
          _log("[Chess Helper] 📊 Cached game result from modal:", cachedGameResult);
        }
      }
      return {
        isOver: true,
        reason: reason
      };
    }
  }
  // If no game-over elements exist in DOM at all, clear the stale text cache.
    if (!foundAnyElement) {
    detectedGameOverTexts.clear();
  }
  return null;
}

/**
 * Convert algebraic notation to file/rank coordinates
 * @param {string} square - Algebraic notation (e.g., 'e2')
 * @returns {Object|null} Object with file (1-8) and rank (1-8)
 */ function algebraicToCoords(square) {
  if (!square || square.length < 2) {
    return null;
  }
  const file = square.charCodeAt(0) - "a".charCodeAt(0) + 1;
  const rank = parseInt(square[1], 10);
  if (file < 1 || file > 8 || rank < 1 || rank > 8) {
    return null;
  }
  return {
    file: file,
    rank: rank
  };
}

/**
 * Parse a UCI move string (e.g., 'e2e4' or 'e7e8q')
 * @param {string} move - UCI format move
 * @returns {Object|null} Object with from/to squares and optional promotion
 */ function parseUciMove(move) {
  if (!move || move.length < 4) {
    return null;
  }
  const from = move.substring(0, 2);
  const to = move.substring(2, 4);
  const promotion = move.length > 4 ? move[4] : null;
  const fromCoords = algebraicToCoords(from);
  const toCoords = algebraicToCoords(to);
  if (!fromCoords || !toCoords) {
    return null;
  }
  return {
    from: {
      square: from,
      ...fromCoords
    },
    to: {
      square: to,
      ...toCoords
    },
    promotion: promotion
  };
}

/**
 * Get the center pixel coordinates for a square on the board
 * @param {number} file - File number (1-8)
 * @param {number} rank - Rank number (1-8)
 * @param {Element} board - The board element
 * @returns {Object|null} Pixel coordinates {x, y} relative to viewport
 */ function getSquarePixelCoords(file, rank, board) {
  const rect = board.getBoundingClientRect();
  const squareSize = rect.width / 8;
  const flipped = isBoardFlipped(board);
  let pixelX, pixelY;
  if (flipped) {
    // Board is flipped (playing as black): a1 is top-right
    pixelX = rect.left + (8 - file) * squareSize + squareSize / 2;
    pixelY = rect.top + (rank - 1) * squareSize + squareSize / 2;
  } else {
    // Normal orientation: a1 is bottom-left
    pixelX = rect.left + (file - 1) * squareSize + squareSize / 2;
    pixelY = rect.top + (8 - rank) * squareSize + squareSize / 2;
  }
  return {
    x: pixelX,
    y: pixelY
  };
}

/**
 * Simulate a mouse click at the given coordinates
 * @param {number} x - X coordinate (viewport)
 * @param {number} y - Y coordinate (viewport)
 * @param {Element} targetElement - Element to dispatch event on
 */ function simulateClick(x, y, targetElement) {
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  };
  // Use the same full event sequence for both platforms.
  // Pointer events + mouse events + click — covers both chess.com and Lichess.
    const pointerDownEvent = new PointerEvent("pointerdown", {
    ...eventOptions,
    pointerType: "mouse",
    isPrimary: true,
    pointerId: 1
  });
  const pointerUpEvent = new PointerEvent("pointerup", {
    ...eventOptions,
    pointerType: "mouse",
    isPrimary: true,
    pointerId: 1
  });
  const mouseDownEvent = new MouseEvent("mousedown", eventOptions);
  const mouseUpEvent = new MouseEvent("mouseup", eventOptions);
  const clickEvent = new MouseEvent("click", eventOptions);
  // Dispatch in realistic order
    targetElement.dispatchEvent(pointerDownEvent);
  targetElement.dispatchEvent(mouseDownEvent);
  targetElement.dispatchEvent(pointerUpEvent);
  targetElement.dispatchEvent(mouseUpEvent);
  targetElement.dispatchEvent(clickEvent);
}

/**
 * Click on a specific square on the board
 * @param {string} square - Algebraic notation (e.g., 'e2')
 * @param {Element} board - The board element
 * @returns {boolean} True if click was successful
 */ function clickSquare(square, board) {
  const coords = algebraicToCoords(square);
  if (!coords) {
    _log("[Chess Helper] [Autoplay] clickSquare: invalid square", square);
    return false;
  }
  const pixelCoords = getSquarePixelCoords(coords.file, coords.rank, board);
  if (!pixelCoords) {
    _log("[Chess Helper] [Autoplay] clickSquare: could not get pixel coords for", square);
    return false;
  }
  // Use elementFromPoint to find the actual element at the click target.
  // Same approach for both chess.com and Lichess — events bubble up to the
  // board container regardless.
    let targetElement = document.elementFromPoint(pixelCoords.x, pixelCoords.y);
  // If we got the overlay, temporarily hide it and try again
    const overlay = document.getElementById("_xo");
  if (targetElement === overlay || overlay && overlay.contains(targetElement)) {
    _log("[Chess Helper] [Autoplay] clickSquare: overlay intercepted, retrying");
    overlay.style.display = "none";
    targetElement = document.elementFromPoint(pixelCoords.x, pixelCoords.y);
    overlay.style.display = "";
  }
  if (!targetElement) {
    _log("[Chess Helper] [Autoplay] clickSquare: no element at", pixelCoords);
    return false;
  }
  _log("[Chess Helper] [Autoplay] Clicking", square, "at", Math.round(pixelCoords.x), Math.round(pixelCoords.y), "on", targetElement.tagName);
  simulateClick(pixelCoords.x, pixelCoords.y, targetElement);
  return true;
}

/**
 * Wait for promotion dialog to appear with retry logic
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {number} interval - Interval between attempts (ms)
 * @returns {Promise<Element|null>} The promotion dialog element or null
 */ async function waitForPromotionDialog(maxAttempts = 20, interval = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (currentPlatform === "lichess") {
      // Lichess: promotion shows as stacked <square> elements inside cg-board
      const board = findBoard();
      if (board) {
        const squares = board.querySelectorAll(sel().promotionElement);
        if (squares.length >= 4) {
          _log("[Chess Helper] [Autoplay] Lichess promotion dialog found after", attempt + 1, "attempts");
          return board;
 // Return the board as the "dialog" container
                }
      }
    } else {
      for (const selector of sel().promotionDialog) {
        const dialog = document.querySelector(selector);
        if (dialog && dialog.offsetParent !== null) {
          _log("[Chess Helper] [Autoplay] Promotion dialog found with selector:", selector, "after", attempt + 1, "attempts");
          return dialog;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  _log("[Chess Helper] [Autoplay] Promotion dialog not found after", maxAttempts, "attempts");
  return null;
}

/**
 * Select a promotion piece from the promotion dialog
 * @param {string} piece - Piece to promote to ('q', 'r', 'b', 'n')
 * @param {Element|null} dialog - Optional dialog element to search within
 * @returns {boolean} True if promotion was selected
 */ function selectPromotionPiece(piece = "q", dialog = null) {
  _log("[Chess Helper] [Autoplay] Attempting to select promotion piece:", piece);
  const pieceNames = {
    q: "queen",
    r: "rook",
    b: "bishop",
    n: "knight"
  };
  const pieceName = pieceNames[piece] || "queen";
  if (currentPlatform === "lichess") {
    // Lichess: promotion squares contain <piece> elements with class like "white queen"
    const board = findBoard();
    if (!board) return false;
    const squares = board.querySelectorAll(sel().promotionElement);
    if (squares.length < 4) return false;
    // Find the square containing the desired piece type
        for (const sq of squares) {
      const pieceEl = sq.querySelector("piece");
      if (pieceEl && pieceEl.className.includes(pieceName)) {
        const rect = sq.getBoundingClientRect();
        simulateClick(rect.left + rect.width / 2, rect.top + rect.height / 2, sq);
        _log("[Chess Helper] [Autoplay] Lichess promotion: clicked", pieceName);
        return true;
      }
    }
    // Fallback: click by position index (queen=0, knight=1, rook=2, bishop=3)
        const pieceIndex = {
      q: 0,
      n: 1,
      r: 2,
      b: 3
    };
    const idx = pieceIndex[piece] ?? 0;
    if (squares[idx]) {
      const rect = squares[idx].getBoundingClientRect();
      simulateClick(rect.left + rect.width / 2, rect.top + rect.height / 2, squares[idx]);
      _log("[Chess Helper] [Autoplay] Lichess promotion: clicked index", idx);
      return true;
    }
    return false;
  }
  // Chess.com: Extended selectors - try multiple patterns
    const selectors = [ 
  // Data attribute patterns
  `[data-piece="${piece}"]`, `[data-piece="${pieceName}"]`, `[data-cy="${pieceName}"]`, 
  // Class-based patterns
  `.promotion-piece.${piece}`, `.promotion-piece.${pieceName}`, `.promotion-piece[class*="${piece}"]`, `[class*="promotion"] [class*="${pieceName}"]`, `[class*="promotion"] [class*="${piece}"]`, 
  // Generic piece patterns
  `.${pieceName}`, `[class*="${pieceName}"]` ];
  const searchRoot = dialog || document;
  // Try each selector
    for (const selector of selectors) {
    try {
      const element = searchRoot.querySelector(selector);
      // Check if element exists and is visible
            if (element && element.offsetParent !== null) {
        _log("[Chess Helper] [Autoplay] Found promotion piece with selector:", selector);
        // Use simulateClick for consistency with other clicks
                const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        simulateClick(x, y, element);
        return true;
      }
    } catch (e) {
      // Invalid selector, skip
    }
  }
  // Fallback: click by position (queen=0, rook=1, bishop=2, knight=3)
    _log("[Chess Helper] [Autoplay] Trying positional fallback for promotion");
  for (const containerSelector of sel().promotionFallbackContainer || []) {
    const container = searchRoot.querySelector(containerSelector);
    if (container) {
      // Find all clickable piece elements
      const pieces = container.querySelectorAll('[class*="piece"], .piece, button, [role="button"]');
      const pieceIndex = {
        q: 0,
        r: 1,
        b: 2,
        n: 3
      };
      const index = pieceIndex[piece] ?? 0;
      if (pieces.length > index && pieces[index]) {
        const element = pieces[index];
        _log("[Chess Helper] [Autoplay] Using positional fallback, clicking index:", index, "of", pieces.length, "pieces");
        const rect = element.getBoundingClientRect();
        simulateClick(rect.left + rect.width / 2, rect.top + rect.height / 2, element);
        return true;
      }
    }
  }
  _log("[Chess Helper] [Autoplay] FAILED: No promotion piece found for", piece);
  return false;
}

/**
 * Cancel any pending autoplay
 */ function cancelAutoplay() {
  if (autoplayTimer) {
    _log("[Chess Helper] [Autoplay] Cancelling pending autoplay");
    clearTimeout(autoplayTimer);
    autoplayTimer = null;
  }
}

/**
 * Execute an autoplay move after the configured delay
 * @param {string} bestMove - UCI format move to play
 * @param {string} fen - The FEN position this move is for
 */ function executeAutoplay(bestMove, fen) {
  _log("[Chess Helper] [Autoplay] Attempting to execute:", bestMove);
  // Don't autoplay if disabled
    if (!autoplayEnabled) {
    _log("[Chess Helper] [Autoplay] ABORT: autoplay disabled");
    return;
  }
  // Don't autoplay if FEN changed
    if (currentFen !== fen) {
    _log("[Chess Helper] [Autoplay] ABORT: FEN changed", {
      expected: fen?.slice(0, 30),
      current: currentFen?.slice(0, 30)
    });
    return;
  }
  // Don't autoplay the same position twice (prevents loops)
    if (lastAutoplayedFen === fen) {
    _log("[Chess Helper] [Autoplay] ABORT: already played this position");
    return;
  }
  const board = findBoard();
  if (!board) {
    _log("[Chess Helper] [Autoplay] ABORT: board not found");
    return;
  }
  const move = parseUciMove(bestMove);
  if (!move) {
    _log("[Chess Helper] [Autoplay] ABORT: invalid move format:", bestMove);
    return;
  }
  // Detect whose turn it is from the FEN
    const fenParts = fen.split(" ");
  const currentTurn = fenParts[1] || "w";
  const flipped = isBoardFlipped(board);
  // Only autoplay if it's our turn
  // If board is flipped, we're black; if not, we're white
    const ourColor = flipped ? "b" : "w";
  _log("[Chess Helper] [Autoplay] Turn check:", {
    currentTurn: currentTurn,
    ourColor: ourColor,
    flipped: flipped
  });
  if (currentTurn !== ourColor) {
    _log("[Chess Helper] [Autoplay] ABORT: not our turn (turn:", currentTurn, "we are:", ourColor, ")");
    return;
  }
  // Mark this position as autoplayed (will be cleared if move fails verification)
    lastAutoplayedFen = fen;
  _log("[Chess Helper] [Autoplay] Executing move", move.from.square, "->", move.to.square);
  // Click the source square (piece selection)
    const sourceClicked = clickSquare(move.from.square, board);
  if (!sourceClicked) {
    _log("[Chess Helper] [Autoplay] FAILED: could not click source square");
    lastAutoplayedFen = null;
 // Allow retry
        return;
  }
  _log("[Chess Helper] [Autoplay] Source square clicked");
  // Delay between source and destination clicks.
  // Lichess/chessground needs more time to process piece selection and compute
  // valid destinations before accepting the second click.
    const clickDelay = currentPlatform === "lichess" ? 200 : 50;
  setTimeout(() => {
    // Verify FEN hasn't changed during the delay
    if (currentFen !== fen) {
      _log("[Chess Helper] [Autoplay] ABORT: FEN changed during delay");
      return;
    }
    // Click the destination square
        const destClicked = clickSquare(move.to.square, board);
    if (!destClicked) {
      _log("[Chess Helper] [Autoplay] FAILED: could not click destination square");
      lastAutoplayedFen = null;
 // Allow retry
            return;
    }
    _log("[Chess Helper] [Autoplay] Destination square clicked - move complete!");
    // We just played our move — set expected turn to opponent's color
    // so the polling loop can correct stale turn detection from the move list DOM
        const fenParts = fen.split(" ");
    const ourTurn = fenParts[1] || "w";
    autoplayExpectedTurn = ourTurn === "w" ? "b" : "w";
    autoplayMoveCount = parseMoveList().length;
    _log("[Chess Helper] [Autoplay] Post-autoplay guard set: expectedTurn=", autoplayExpectedTurn, "moveCount=", autoplayMoveCount);
    // Immediately clear the overlay and show waiting state so the user
    // doesn't see a stale calculation arrow during the opponent's turn
        window.dispatchEvent(new CustomEvent("_xw", {
      detail: {
        playerColor: ourTurn,
        currentTurn: autoplayExpectedTurn
      }
    }));
    // Verify the move actually happened: check if FEN changed after a short delay.
    // If the board didn't change, the synthetic click didn't register — clear
    // lastAutoplayedFen so the system can retry on the next poll cycle.
        setTimeout(() => {
      clearMoveListCache();
      const postMoveFen = extractFen();
      if (postMoveFen && postMoveFen === fen) {
        _warn("[Chess Helper] [Autoplay] Move verification FAILED: FEN unchanged after", move.from.square, "->", move.to.square);
        lastAutoplayedFen = null;
 // Allow retry
                autoplayExpectedTurn = null;
        autoplayMoveCount = null;
      } else {
        _log("[Chess Helper] [Autoplay] Move verified: FEN changed");
      }
    }, 500);
    // Safety: auto-clear after 3s if DOM never catches up
        setTimeout(() => {
      if (autoplayExpectedTurn) {
        _warn("[Chess Helper] [Autoplay] Safety timeout: clearing stale post-autoplay guard");
        autoplayExpectedTurn = null;
        autoplayMoveCount = null;
      }
    }, 3e3);
    // Handle promotion if needed
        if (move.promotion) {
      // Wait for promotion dialog to appear with retry logic
      _log("[Chess Helper] [Autoplay] Waiting for promotion dialog...");
      waitForPromotionDialog(20, 50).then(dialog => {
        if (dialog) {
          const promoted = selectPromotionPiece(move.promotion, dialog);
          _log("[Chess Helper] [Autoplay] Promotion to", move.promotion, promoted ? "succeeded" : "failed");
        } else {
          _log("[Chess Helper] [Autoplay] FAILED: Promotion dialog never appeared");
        }
      });
    }
  }, clickDelay);
}

/**
 * Calculate autoplay delay with optional random variation
 * Uses a bell-curve distribution to make timing more natural
 * @returns {number} Delay in milliseconds
 */ function calculateAutoplayDelay() {
  if (!autoplayVariationEnabled) {
    return autoplayDelay;
 // Fixed delay if variation disabled
    }
  // Use Box-Muller transform for normal (bell-curve) distribution
  // This creates timing that clusters around the midpoint with occasional faster/slower moves
    const midpoint = (autoplayDelayMin + autoplayDelayMax) / 2;
  const range = autoplayDelayMax - autoplayDelayMin;
  const stdDev = range / 6;
 // 99.7% of values within range
  // Box-Muller transform
    const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Apply to get delay
    let delay = midpoint + z * stdDev;
  // Clamp to min/max bounds
    delay = Math.max(autoplayDelayMin, Math.min(autoplayDelayMax, delay));
  return Math.round(delay);
}

/**
 * Schedule an autoplay move with the configured delay
 * @param {string} bestMove - UCI format move to play
 * @param {string} fen - The FEN position this move is for
 */ function scheduleAutoplay(bestMove, fen) {
  // Cancel any existing autoplay
  cancelAutoplay();
  if (!autoplayEnabled) {
    _log("[Chess Helper] [Autoplay] Disabled, skipping schedule");
    return;
  }
  if (!bestMove) {
    _log("[Chess Helper] [Autoplay] No best move provided, skipping");
    return;
  }
  // Calculate delay with variation
    const actualDelay = calculateAutoplayDelay();
  _log("[Chess Helper] [Autoplay] Scheduling move:", bestMove, "with delay:", actualDelay, "ms", autoplayVariationEnabled ? `(range: ${autoplayDelayMin}-${autoplayDelayMax})` : "(fixed)");
  // Schedule the autoplay after the calculated delay
    autoplayTimer = setTimeout(() => {
    executeAutoplay(bestMove, fen);
  }, actualDelay);
}

/**
 * Generate a new game ID for worker affinity
 * Called when a new game is detected
 */ function generateNewGameId() {
  currentGameId = crypto.randomUUID();
  detectedTimeControl = null;
 // Reset time control for new game
    if (antidetectEnabled) {
    rollNextWeakMoveThreshold();
  }
  _log("[Chess Helper] 🎮 New game detected, generated game ID:", currentGameId);
  return currentGameId;
}

/**
 * Roll a new random threshold for the next weak move (antidetect)
 * Called on new game and after each weak move
 */ function rollNextWeakMoveThreshold() {
  antidetectNextWeakAt = antidetectIntervalMin + Math.floor(Math.random() * (antidetectIntervalMax - antidetectIntervalMin + 1));
  antidetectMoveCounter = 0;
  _log("[Chess Helper] [Antidetect] Next weak move at move:", antidetectNextWeakAt);
}

/**
 * Parse clock display text to seconds
 * @param {string} text - Clock text like "5:00", "1:30", "0:45"
 * @returns {number} Seconds
 */ function parseClockToSeconds(text) {
  if (!text) return 0;
  const parts = text.split(":").map(p => parseInt(p.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

/**
 * Parse time control text like "5 | 0", "3+2", "10 min"
 * @param {string} text - Time control text
 * @returns {Object|null} { baseTime, increment, category }
 */ function parseTimeControlText(text) {
  if (!text) return null;
  // Match "5 | 0", "5|0", "5 | 2"
    let match = text.match(/(\d+)\s*\|\s*(\d+)/);
  if (match) {
    return categorizeTimeControl(parseInt(match[1]) * 60, parseInt(match[2]));
  }
  // Match "3+2", "10+5"
    match = text.match(/(\d+)\s*\+\s*(\d+)/);
  if (match) {
    return categorizeTimeControl(parseInt(match[1]) * 60, parseInt(match[2]));
  }
  // Match "5 min", "10min"
    match = text.match(/(\d+)\s*min/i);
  if (match) {
    return categorizeTimeControl(parseInt(match[1]) * 60, 0);
  }
  return null;
}

/**
 * Categorize time control based on base time and increment
 * Uses chess.com's standard categories
 * @param {number} baseSeconds - Base time in seconds
 * @param {number} increment - Increment in seconds
 * @returns {Object} { baseTime, increment, category }
 */ function categorizeTimeControl(baseSeconds, increment) {
  const estimated = baseSeconds + 40 * increment;
  let category;
  if (estimated < 180) category = "bullet"; else if (estimated < 600) category = "blitz"; else if (estimated < 1800) category = "rapid"; else category = "classical";
  return {
    baseTime: baseSeconds,
    increment: increment,
    category: category
  };
}

/**
 * Detect the time control of the current game from chess.com UI
 * @returns {Object|null} { baseTime: seconds, increment: seconds, category: string }
 */ function detectTimeControl() {
  if (currentPlatform === "lichess") {
    // Lichess Strategy 1: Parse from setup element (e.g., "3+0 • Casual • Blitz")
    const setup = queryFirst(sel().timeSetup);
    if (setup) {
      const text = setup.textContent;
      const match = text.match(/(\d+)\+(\d+)/);
      if (match) {
        return categorizeTimeControl(parseInt(match[1]) * 60, parseInt(match[2]));
      }
    }
    // Lichess Strategy 2: Check clock elements for initial time
        for (const clockSel of sel().clockDisplay) {
      const clocks = document.querySelectorAll(clockSel);
      if (clocks.length >= 2) {
        let maxSeconds = 0;
        for (const clock of clocks) {
          const seconds = parseClockToSeconds(clock.textContent.trim());
          if (seconds > maxSeconds) maxSeconds = seconds;
        }
        if (maxSeconds > 0) return categorizeTimeControl(maxSeconds, 0);
      }
    }
    // Lichess Strategy 3: URL or game type hints
        const url = window.location.href;
    if (url.includes("bullet")) return categorizeTimeControl(60, 0);
    if (url.includes("blitz")) return categorizeTimeControl(300, 0);
    if (url.includes("rapid")) return categorizeTimeControl(600, 0);
    if (url.includes("classical")) return categorizeTimeControl(1800, 0);
    return null;
  }
  // Chess.com Strategy 1: Time selector button (e.g., "10 min (Rapid)")
  // This is the most reliable — the button in .time-selector-next-component
  // persists in the sidebar and contains both time and category.
    const timeSelectorBtn = queryFirst(sel().timeControl);
  if (timeSelectorBtn) {
    const btnText = timeSelectorBtn.textContent.trim();
    // Match "10 min (Rapid)", "3 min (Blitz)", "1 min (Bullet)", etc.
        const catMatch = btnText.match(/(\d+)\s*min\s*\((\w+)\)/i);
    if (catMatch) {
      const minutes = parseInt(catMatch[1]);
      return categorizeTimeControl(minutes * 60, 0);
    }
    // Also try "X | Y" or "X+Y" format in button text
        const parsed = parseTimeControlText(btnText);
    if (parsed) return parsed;
  }
  // Chess.com Strategy 2: Look for time control text in game info
    for (const selector of sel().timeControlInfo) {
    const el = document.querySelector(selector);
    if (el) {
      const parsed = parseTimeControlText(el.textContent.trim());
      if (parsed) return parsed;
    }
  }
  // Strategy 3: Parse from clock initial values
    for (const selector of sel().clockDisplay) {
    const clocks = document.querySelectorAll(selector);
    if (clocks.length >= 2) {
      let maxSeconds = 0;
      for (const clock of clocks) {
        const seconds = parseClockToSeconds(clock.textContent.trim());
        if (seconds > maxSeconds) maxSeconds = seconds;
      }
      if (maxSeconds > 0) {
        return categorizeTimeControl(maxSeconds, 0);
      }
    }
  }
  // Strategy 4: Check URL for game type hints
    const url = window.location.href;
  if (url.includes("bullet")) return categorizeTimeControl(60, 0);
  if (url.includes("blitz")) return categorizeTimeControl(300, 0);
  if (url.includes("rapid")) return categorizeTimeControl(600, 0);
  // Strategy 5: Look for game category labels
    for (const selector of sel().gameCategory) {
    const el = document.querySelector(selector);
    if (el) {
      const text = el.textContent.toLowerCase();
      if (text.includes("bullet")) return categorizeTimeControl(60, 0);
      if (text.includes("blitz")) return categorizeTimeControl(300, 0);
      if (text.includes("rapid")) return categorizeTimeControl(600, 0);
      if (text.includes("classical") || text.includes("daily")) return categorizeTimeControl(1800, 0);
    }
  }
  return null;
}

/**
 * Get maxTimeMs for the API based on detected time control
 * @returns {number} Max analysis time in milliseconds
 */ function getMaxTimeForTimeControl() {
  if (!detectedTimeControl) {
    detectedTimeControl = detectTimeControl();
  }
  if (!detectedTimeControl) {
    _log("[Chess Helper] ⏱️ Time control not detected, using default maxTimeMs: 2000");
    return 2e3;
  }
  const {baseTime: baseTime, category: category} = detectedTimeControl;
  let maxTimeMs;
  if (category === "bullet") {
    maxTimeMs = baseTime <= 60 ? 500 : 800;
  } else if (category === "blitz") {
    maxTimeMs = baseTime <= 180 ? 1e3 : 2e3;
  } else if (category === "rapid") {
    maxTimeMs = baseTime <= 600 ? 3e3 : 5e3;
  } else {
    maxTimeMs = 5e3;
  }
  _log("[Chess Helper] ⏱️ Time control:", category, `(${baseTime}s +${detectedTimeControl.increment}s)`, "→ maxTimeMs:", maxTimeMs);
  return maxTimeMs;
}

/**
 * Safely send a message to the service worker
 * Handles extension context invalidation gracefully
 * @param {Object} message - Message to send
 */ function safeSendMessage(message) {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      return false;
    }
    chrome.runtime.sendMessage(message);
    return true;
  } catch (error) {
    // Extension context invalidated (extension was reloaded/updated)
    return false;
  }
}

/**
 * Request analysis using ChessHelper AI API
 * @param {string} fen - FEN string to analyze
 * @param {boolean} _isNewGame - Whether this is a new game (unused, kept for API consistency)
 */ async function requestAnalysis(fen, _isNewGame = false) {
  // Check if extension is completely disabled
  if (!extensionEnabled) {
    _log("[Chess Helper] ⚠️ Analysis skipped - extension is disabled");
    return;
  }
  if (!isAnalysisEnabled) {
    return;
  }
  // Rate limit cooldown — stop hammering the API after a 429
    if (Date.now() < rateLimitedUntil) {
    return;
  }
  if (!isValidFen(fen)) {
    return;
  }
  // Only analyze when it's the player's turn
    const board = findBoard();
  if (board) {
    const fenParts = fen.split(" ");
    const currentTurn = fenParts[1] || "w";
    const flipped = isBoardFlipped(board);
    const playerColor = flipped ? "b" : "w";
    // Check if this is game start (starting position)
        const isStartingPosition = fenParts[0] === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
    if (currentTurn !== playerColor) {
      // Not our turn - show waiting state
      window.dispatchEvent(new CustomEvent("_xw", {
        detail: {
          playerColor: playerColor,
          currentTurn: currentTurn
        }
      }));
      return;
    }
    // At this point, it IS our turn - proceed with analysis
        if (isStartingPosition && playerColor === "w") {
      _log("[Chess Helper] 🎮 Game start - analyzing first move");
    }
  }
  // Check for game end state before requesting analysis
    const gameState = detectGameEndState(fen);
  // Skip UI game-end detection during grace period after new game detection —
  // chess.com's game-over modal may linger in DOM during game transitions
    const uiGameState = Date.now() < newGameGracePeriodUntil ? null : detectGameEndFromUI();
  if (gameState.isOver || uiGameState?.isOver) {
    isGameOver = true;
    gameOverReason = gameState.reason || uiGameState?.reason;
    gameEndWinner = gameState.winner || null;
 // 'white'/'black' for checkmate
    // Send game ended event to server (fire-and-forget)
        sendGameEnded("finished");
    // Dispatch game over event for overlay
        window.dispatchEvent(new CustomEvent("_xg", {
      detail: {
        reason: gameOverReason,
        winner: gameState.winner
      }
    }));
    // Clear any analysis overlay
        window.dispatchEvent(new CustomEvent("_xc"));
    cancelAutoplay();
    return;
  }
  // Reset game over state if position is playable
    isGameOver = false;
  gameOverReason = null;
  gameEndWinner = null;
  cachedGameResult = null;
  // Deduplication: skip if we already analyzed (or are analyzing) the same board position.
  // The non-position FEN parts (turn, castling, fullmove) can fluctuate between polls
  // as the move list DOM updates after the board DOM, so deduplicate on position only.
    const position = fen.split(" ")[0];
  if (lastApiPosition === position) {
    _log("[Chess Helper] ⚠️ Already analyzed this position, skipping duplicate request");
    return;
  }
  // Generate unique request ID to track this analysis
    currentRequestId++;
  const requestId = currentRequestId;
  pendingRequestId = requestId;
  isAnalyzing = true;
  lastApiPosition = position;
  // Show "Analyzing..." status pill in overlay
    window.dispatchEvent(new CustomEvent("_xz"));
  try {
    // Use ChessHelper AI API from config
    const apiUrl = window._cfg?.API_URL || "http://localhost:3000/api/analyze";
    const depth = analysisDepth || window._cfg?.API_DEPTH || 15;
    // Antidetect: determine if this should be a weak move
        antidetectIsWeakMove = false;
    if (antidetectEnabled) {
      antidetectMoveCounter++;
      if (antidetectMoveCounter >= antidetectNextWeakAt) {
        antidetectIsWeakMove = true;
        _log("[Chess Helper] [Antidetect] Weak move triggered at count:", antidetectMoveCounter);
      }
    }
    const effectiveDepth = antidetectIsWeakMove ? 2 : depth;
    // Generate game ID if not set (new game)
        if (!currentGameId) {
      generateNewGameId();
    }
    // Use background script proxy to bypass CSP restrictions
        const response = await chrome.runtime.sendMessage({
      type: "API_ANALYZE",
      fen: fen,
      depth: effectiveDepth,
      apiUrl: apiUrl,
      gameId: currentGameId,
      maxTimeMs: getMaxTimeForTimeControl()
    });
    // Guard: if the service worker didn't respond (e.g. it restarted),
    // treat it like a transient error but keep the dedup guard active.
        if (!response) {
      _warn("[Chess Helper] ⚠️ No response from service worker");
      isAnalyzing = false;
      pendingRequestId = null;
      // Show retry in overlay instead of silently failing
            window.dispatchEvent(new CustomEvent("_xe", {
        detail: {
          error: "Connection lost",
          canRetry: true
        }
      }));
      return;
    }
    if (!response.success) {
      _warn("[Chess Helper] API response indicated failure:", response);
      // Handle rate limiting (429) — show signup/upgrade overlay
      if (response.rateLimited) {
        _warn("[Chess Helper] ⏳ Rate limited by API");
        isAnalyzing = false;
        // Do NOT clear lastApiPosition — keeps the dedup guard active so the
        // polling loop won't re-request the same position.
        // Set a 30-second cooldown to stop all API calls while rate limited.
                rateLimitedUntil = Date.now() + 3e4;
        pendingRequestId = null;
        // Dispatch rate limit event to overlay for signup/upgrade prompt
                if (response.rateLimitData) {
          window.dispatchEvent(new CustomEvent("_xrl", {
            detail: response.rateLimitData
          }));
        }
        return;
      }
      // Handle unauthorized (401) — token expired
            if (response.unauthorized) {
        _warn("[Chess Helper] 🔑 Token expired or invalid");
      }
      // Handle server overloaded (503 - retries already exhausted in service worker)
            if (response.serverOverloaded) {
        _warn("[Chess Helper] 🔄 Server overloaded, analysis unavailable temporarily");
      }
      // Handle analysis timeout (504 - position too complex)
            if (response.timeout) {
        _warn("[Chess Helper] ⏱️ Analysis timed out for this position");
      }
      // Handle forbidden (403 - retries exhausted in service worker)
            if (response.forbidden) {
        _warn("[Chess Helper] 🚫 Access denied (403)");
      }
      const err = new Error(response.error || "Analysis failed");
      err._canRetry = !response.rateLimited;
      throw err;
    }
    let data = response.data;
    if (data?.data && !data.analysis) {
      _warn("[Chess Helper] API response has nested data wrapper, unwrapping");
      data = data.data;
    }
    _log("[Chess Helper] API analyze response data:", data);
    // Check if this result is still relevant
        if (requestId !== pendingRequestId) {
      _warn("[Chess Helper] ⚠️ Ignoring stale result - Request ID:", requestId, "!==", pendingRequestId);
      return;
    }
    isAnalyzing = false;
    pendingRequestId = null;
    // NOTE: lastApiPosition is intentionally NOT cleared on success.
    // It must persist so the dedup check blocks subsequent polls that
    // produce slightly different FENs for the same board position
    // (e.g., when the move list DOM updates after the board DOM).
        if (data.success && data.analysis?.bestMove) {
      const {bestMove: bestMove, ponder: ponder, evaluation: evaluation, mate: mate, depth: actualDepth} = data.analysis;
      const {fallbackUsed: fallbackUsed, alternativeUsed: alternativeUsed, cached: cached} = data.meta || {};
      // Log quality indicators from meta
            if (fallbackUsed) {
        _warn("[Chess Helper] ⚠️ Fallback analysis used - move quality may be lower");
      }
      if (alternativeUsed) {
        _info("[Chess Helper] ♻️ Alternative move chosen to avoid draw by repetition");
      }
      if (cached) {
        _log("[Chess Helper] 📦 Result from cache");
      }
      // Determine confidence level based on meta
            const confidence = !fallbackUsed && !alternativeUsed ? "high" : "medium";
      // Transform evaluation to match overlay format
            let evalData;
      if (mate !== null && mate !== undefined) {
        evalData = {
          type: "mate",
          value: mate,
          depth: actualDepth
        };
      } else {
        evalData = {
          type: "cp",
          value: evaluation || 0,
          depth: actualDepth
        };
      }
      _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      _log("🎯 BEST MOVE:", bestMove);
      _log("📊 Evaluation:", evalData);
      _log("🎚️ Confidence:", confidence);
      _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // Dispatch to overlay
            window.dispatchEvent(new CustomEvent("_xa", {
        detail: {
          bestMove: bestMove,
          ponderMove: ponder,
          evaluation: evalData,
          fen: fen,
          isWeakMove: antidetectIsWeakMove
        }
      }));
      // Store last analysis result for autoplay toggle
            lastBestMove = bestMove;
      lastBestMoveFen = fen;
      // Schedule autoplay if enabled
            if (autoplayEnabled) {
        scheduleAutoplay(bestMove, fen);
      }
      // Reset antidetect counter after weak move
            if (antidetectIsWeakMove) {
        rollNextWeakMoveThreshold();
      }
    } else {
      _warn("[Chess Helper] No analysis available from API");
      isAnalyzing = false;
      lastApiPosition = null;
    }
  } catch (error) {
    _err("[Chess Helper] ❌ Analysis error:", error);
    isAnalyzing = false;
    // Do NOT clear lastApiPosition here — clearing it removes the dedup guard
    // and allows the polling loop to retry the same position, causing infinite
    // loops on persistent errors. The guard resets naturally when the position
    // changes or a new game starts.
        pendingRequestId = null;
    // Dispatch error event with retry flag
        window.dispatchEvent(new CustomEvent("_xe", {
      detail: {
        error: error.message,
        canRetry: error._canRetry !== undefined ? error._canRetry : true
      }
    }));
  }
}

/**
 * Handle board position changes with debouncing
 */ function handlePositionChange() {
  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  // Cancel any pending autoplay when position changes
    cancelAutoplay();
  // Debounce rapid position changes
    debounceTimer = setTimeout(() => {
    // Clear move list cache before extracting new position
    clearMoveListCache();
    const newFen = extractFen();
    if (!newFen) return;
    // Post-autoplay turn correction (same logic as polling loop)
        let correctedFen = newFen;
    if (autoplayExpectedTurn !== null && autoplayMoveCount !== null) {
      const parts = newFen.split(" ");
      const detectedTurn = parts[1];
      const currentMoveCount = parseMoveList().length;
      if (currentMoveCount <= autoplayMoveCount) {
        if (detectedTurn !== autoplayExpectedTurn) {
          _log("[Chess Helper] [Autoplay] Correcting stale turn in debounce:", detectedTurn, "->", autoplayExpectedTurn);
          parts[1] = autoplayExpectedTurn;
          correctedFen = parts.join(" ");
        }
      } else {
        autoplayExpectedTurn = null;
        autoplayMoveCount = null;
      }
    }
    if (correctedFen !== currentFen) {
      // Detect new game: either no previous FEN, or previous game ended
      const isNewGame = !currentFen || isGameOver;
      currentFen = correctedFen;
      // Reset state on new game
            if (isNewGame) {
        resetForNewGame({
          source: "handlePositionChange"
        });
      }
      // Request new analysis (handles stopping previous analysis internally)
            requestAnalysis(correctedFen, isNewGame);
    }
  }, DEBOUNCE_DELAY);
}

/**
 * Wait for pieces to load on the board before extracting position
 * @param {number} retries - Number of retries left
 * @param {number} delay - Delay between retries in ms
 */ function waitForPiecesToLoad(retries = 20, delay = 250) {
  const board = findBoard();
  if (!board) {
    _warn("[Chess Helper] Board not found while waiting for pieces");
    if (retries > 0) {
      setTimeout(() => waitForPiecesToLoad(retries - 1, delay), delay);
    }
    return;
  }
  // Access correct root for piece queries
    const root = currentPlatform === "lichess" ? board : board.shadowRoot || board;
  const pieceSelector = sel().pieces;
  const pieces = root.querySelectorAll(pieceSelector);
  _log(`[Chess Helper] ⏳ Waiting for pieces... Found ${pieces.length} pieces (attempt ${21 - retries}/20)`);
  if (pieces.length > 0) {
    _log("[Chess Helper] ✅ Pieces loaded! Starting position extraction...");
    // Run selector diagnostics now that game elements are in the DOM
        reportSelectorDiagnostics();
    handlePositionChange();
  } else if (retries > 0) {
    // Try again
    setTimeout(() => waitForPiecesToLoad(retries - 1, delay), delay);
  } else {
    _err("[Chess Helper] ❌ Timeout: Pieces never loaded after 5 seconds");
    sendDomHealthReport("pieces_timeout");
  }
}

/**
 * Set up polling to detect board changes
 */ function setupBoardObserver() {
  // Prevent duplicate setup calls (even while initializing)
  if (pollingInterval || isSettingUp) {
    _log("[Chess Helper] ⚠️ Setup already in progress or polling active, skipping");
    return;
  }
  isSettingUp = true;
  const board = findBoard(false);
 // Don't use cache for setup
    if (!board) {
    // Board not found, try again later
    _log("[Chess Helper] Board not found, will retry in 1s");
    sendDomHealthReport("board_not_found");
    isSettingUp = false;
    setTimeout(setupBoardObserver, 1e3);
    return;
  }
  _log("[Chess Helper] ✅ Setting up polling (every 500ms) for position changes");
  // Start periodic DOM health monitoring (~10 checks/day)
    startPeriodicHealthCheck();
  // Wait for pieces to load before starting polling
    _log("[Chess Helper] Waiting for pieces to load...");
  waitForPiecesToLoad();
  // Poll for position changes every 500ms
    pollingInterval = setInterval(() => {
    // Check for game end from UI even when FEN hasn't changed and even if
    // analysis is disabled. This catches timeout, resignation, opponent leaving —
    // situations where the board position doesn't change but the game is over.
    if (!isGameOver && gameTrackingSent && Date.now() >= newGameGracePeriodUntil) {
      const uiEnd = detectGameEndFromUI();
      if (uiEnd?.isOver) {
        isGameOver = true;
        gameOverReason = uiEnd.reason;
        sendGameEnded("finished");
        window.dispatchEvent(new CustomEvent("_xg", {
          detail: {
            reason: gameOverReason
          }
        }));
        window.dispatchEvent(new CustomEvent("_xc"));
        cancelAutoplay();
        return;
      }
    }
    if (!isAnalysisEnabled) return;
    // Clear move list cache before extracting position
        clearMoveListCache();
    const newFen = extractFen();
    if (!newFen) return;
    const newPosition = newFen.split(" ")[0];
    // Position stability check (both platforms):
    // The board DOM updates BEFORE the move list DOM on both chess.com and
    // Lichess. If we analyze immediately, detectTurn() uses the stale move
    // list and thinks it's still our turn, firing a wrong suggestion.
    // Fix: when the position first changes, record it and skip this poll.
    // On the next poll (500ms later), the move list will have caught up and
    // turn detection will be correct.
        if (newPosition !== lastPolledPosition) {
      lastPolledPosition = newPosition;
      // Clear stale arrows/eval immediately so old analysis doesn't linger during stability wait
      // Use targeted clear (_xca) to preserve toggles and waiting indicator
            window.dispatchEvent(new CustomEvent("_xca"));
      return;
 // Position just changed — wait for next poll to confirm stability
        }
    lastPolledPosition = newPosition;
    // Post-autoplay turn correction: chess.com updates piece DOM before
    // the move list DOM, so detectTurn() can return a stale turn.
    // Use the stored move count to detect this and override the turn.
        let correctedFen = newFen;
    if (autoplayExpectedTurn !== null && autoplayMoveCount !== null) {
      const parts = newFen.split(" ");
      const detectedTurn = parts[1];
      const currentMoveCount = parseMoveList().length;
      if (currentMoveCount <= autoplayMoveCount) {
        // Move list is stale — override the turn
        if (detectedTurn !== autoplayExpectedTurn) {
          _log("[Chess Helper] [Autoplay] Correcting stale turn:", detectedTurn, "->", autoplayExpectedTurn, "(moveCount:", currentMoveCount, "expected >", autoplayMoveCount, ")");
          parts[1] = autoplayExpectedTurn;
          correctedFen = parts.join(" ");
        }
      } else {
        // Move list caught up (or opponent already moved too) — clear guard
        _log("[Chess Helper] [Autoplay] Move list caught up (count:", currentMoveCount, "> autoplay count:", autoplayMoveCount, "). Clearing post-autoplay guard.");
        autoplayExpectedTurn = null;
        autoplayMoveCount = null;
      }
    }
    if (correctedFen !== currentFen) {
      // Detect new game: either no previous FEN, or previous game ended
      const isNewGame = !currentFen || isGameOver;
      currentFen = correctedFen;
      if (isNewGame) {
        resetForNewGame({
          source: "pollingLoop"
        });
      }
      requestAnalysis(correctedFen, isNewGame);
    }
  }, 500);
  // Mark setup as complete
    isSettingUp = false;
}

/**
 * Handle messages from the service worker (settings only)
 */ chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
   case "SETTINGS_RESPONSE":
   case "SETTINGS_CHANGED":
    const settings = message.settings;
    _log("[Chess Helper] Settings received:", settings);
    if (settings.extensionEnabled !== undefined) {
      const wasEnabled = extensionEnabled;
      extensionEnabled = settings.extensionEnabled;
      // Clear everything if extension disabled
            if (wasEnabled && !extensionEnabled) {
        window.dispatchEvent(new CustomEvent("_xc"));
        cancelAutoplay();
      }
    }
    if (settings.analysisEnabled !== undefined) {
      isAnalysisEnabled = settings.analysisEnabled;
    }
    if (settings.depth !== undefined) {
      analysisDepth = settings.depth;
    }
    if (settings.autoplayEnabled !== undefined) {
      const wasEnabled = autoplayEnabled;
      autoplayEnabled = settings.autoplayEnabled;
      // Cancel pending autoplay if disabled
            if (wasEnabled && !autoplayEnabled) {
        cancelAutoplay();
      }
      // Reset lastAutoplayedFen when enabling to allow fresh autoplay
            if (!wasEnabled && autoplayEnabled) {
        lastAutoplayedFen = null;
        autoplayExpectedTurn = null;
        autoplayMoveCount = null;
      }
    }
    if (settings.autoplayDelay !== undefined) {
      autoplayDelay = settings.autoplayDelay;
    }
    if (settings.autoplayDelayMin !== undefined) {
      autoplayDelayMin = settings.autoplayDelayMin;
    }
    if (settings.autoplayDelayMax !== undefined) {
      autoplayDelayMax = settings.autoplayDelayMax;
    }
    if (settings.autoplayVariationEnabled !== undefined) {
      autoplayVariationEnabled = settings.autoplayVariationEnabled;
    }
    if (settings.antidetectEnabled !== undefined) {
      antidetectEnabled = settings.antidetectEnabled;
      if (antidetectEnabled && antidetectNextWeakAt === 0) {
        rollNextWeakMoveThreshold();
      }
    }
    if (settings.antidetectIntervalMin !== undefined) {
      antidetectIntervalMin = settings.antidetectIntervalMin;
    }
    if (settings.antidetectIntervalMax !== undefined) {
      antidetectIntervalMax = settings.antidetectIntervalMax;
    }
    // Dispatch settings update event
        window.dispatchEvent(new CustomEvent("_xs", {
      detail: settings
    }));
    // If analysis was disabled, clear overlay and cancel autoplay
        if (!isAnalysisEnabled) {
      window.dispatchEvent(new CustomEvent("_xc"));
      cancelAutoplay();
    } else if (currentFen && (settings.depth !== undefined || settings.analysisEnabled !== undefined)) {
      // Only re-analyze if a setting that affects analysis output changed (depth, analysisEnabled)
      // Toggle-only changes (autoplay, antidetect) don't need re-analysis
      lastApiPosition = null;
      requestAnalysis(currentFen, false);
    }
    break;

   case "TOKEN_CAPTURED":
    // User just signed up/connected — dismiss the rate limit overlay
    _log("[Chess Helper] Token captured, removing rate limit overlay");
    window.dispatchEvent(new CustomEvent("_xc"));
 // clear analysis overlay
        const rateLimitOverlay = document.getElementById("chess-helper-overlay");
    if (rateLimitOverlay) rateLimitOverlay.remove();
    rateLimitedUntil = 0;
 // Clear cooldown so analysis resumes immediately
        if (currentFen && isAnalysisEnabled) {
      lastApiPosition = null;
      requestAnalysis(currentFen, false);
    }
    break;

   default:
    break;
  }
  return true;
});

/**
 * Clean up all state when board is removed or navigating away
 */ function cleanupState() {
  _log("[Chess Helper] 🧹 Cleaning up state...");
  // Stop any pending analysis
    if (isAnalyzing) {
    safeSendMessage({
      type: "STOP_ANALYSIS"
    });
    isAnalyzing = false;
    lastApiPosition = null;
  }
  lastPolledPosition = null;
  // Clear timers and polling
    if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  cancelAutoplay();
  // Disconnect board observer
    if (boardObserver) {
    boardObserver.disconnect();
    boardObserver = null;
  }
  // Reset state flags
    currentFen = null;
  pendingRequestId = null;
  currentGameId = null;
 // Reset game ID for new game
    detectedTimeControl = null;
 // Reset time control for new game
    isGameOver = false;
  gameOverReason = null;
  gameEndWinner = null;
  cachedGameResult = null;
  detectedGameOverTexts.clear();
 // Full cleanup — allow fresh detection
    lastAutoplayedFen = null;
  autoplayExpectedTurn = null;
  autoplayMoveCount = null;
  lastGameUrl = null;
  cachedBoard = null;
  isSettingUp = false;
 // Reset setup flag
    antidetectMoveCounter = 0;
  antidetectNextWeakAt = 0;
  antidetectIsWeakMove = false;
  // Clear overlay
    window.dispatchEvent(new CustomEvent("_xc"));
}

/**
 * Reset state for a new game (without tearing down polling/observers).
 * Consolidates the duplicate new-game reset logic from handlePositionChange,
 * the polling loop, and checkForNewGameUrl.
 * @param {Object} options
 * @param {string} options.source - Where this was called from (for logging)
 * @param {boolean} options.sendGameStartedDelay - Force sendGameStarted after delay
 * @param {boolean} options.resetUrlTracking - Whether to reset via background script
 * @param {boolean} options.skipGameEnded - Skip sending game ended (caller already handled it)
 */ function resetForNewGame({source: source = "unknown", sendGameStartedDelay: sendGameStartedDelay = false, resetUrlTracking: resetUrlTracking = false, skipGameEnded: skipGameEnded = false} = {}) {
  _log(`[Chess Helper] 🔄 New game reset (source: ${source})`);
  // End previous game tracking if active
    if (!skipGameEnded && gameTrackingSent) {
    sendGameEnded("finished");
  }
  // Reset autoplay state
    lastAutoplayedFen = null;
  autoplayExpectedTurn = null;
  autoplayMoveCount = null;
  // Reset game over state
    isGameOver = false;
  gameOverReason = null;
  gameEndWinner = null;
  cachedGameResult = null;
  // Reset analysis dedup and last result
    lastApiPosition = null;
  lastPolledPosition = null;
  lastBestMove = null;
  lastBestMoveFen = null;
  // Grace period to suppress false game-end detection
    newGameGracePeriodUntil = Date.now() + 5e3;
  // Disable autoplay (user must re-enable)
    autoplayEnabled = false;
  cancelAutoplay();
  chrome.storage.local.set({
    autoplayEnabled: false
  });
  // Send both toggle states so overlay recreates both after _xng teardown
    window.dispatchEvent(new CustomEvent("_xs", {
    detail: {
      autoplayEnabled: false,
      antidetectEnabled: antidetectEnabled
    }
  }));
  // Generate new game ID
    currentGameId = null;
  generateNewGameId();
  // Reset tracking
    gameTrackingSent = false;
  // Reset antidetect state
    antidetectMoveCounter = 0;
  antidetectNextWeakAt = 0;
  if (antidetectEnabled) {
    rollNextWeakMoveThreshold();
  }
  // Reset time control detection
    detectedTimeControl = null;
  // Clear rate limit cooldown for new game
    rateLimitedUntil = 0;
  // CRITICAL: Reset cachedBoard to force fresh DOM lookup
    cachedBoard = null;
  // Tell overlay to fully reset (remove stale container for fresh recreation)
    window.dispatchEvent(new CustomEvent("_xng"));
  // Reset via background script if needed
    if (resetUrlTracking) {
    safeSendMessage({
      type: "RESET_GAME_ID"
    });
  }
  // Schedule game started notification
    if (sendGameStartedDelay) {
    setTimeout(() => sendGameStarted(), 1500);
  } else if (!extractGamePath()) {
    setTimeout(() => sendGameStarted(), 1500);
  }
}

/**
 * Full cleanup including all event listeners
 * Called when the content script is being unloaded
 */ function fullCleanup() {
  cleanupState();
  // Disconnect page observer
    if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  // Abort all event listeners registered with the controller
    if (eventListenerController) {
    eventListenerController.abort();
    eventListenerController = null;
  }
}

/**
 * Extract the game-specific portion of the current URL
 * Returns a normalized game path or null if not on a game page
 * @returns {string|null}
 */ function extractGamePath() {
  const url = window.location.href;
  // Chess.com: /game/live/<id> or /game/daily/<id>
    const chessComMatch = url.match(/chess\.com\/game\/(live|daily)\/(\d+)/);
  if (chessComMatch) {
    return `chess.com/game/${chessComMatch[1]}/${chessComMatch[2]}`;
  }
  // Lichess: /<8-char gameId> (e.g., lichess.org/AbCdEfGh)
    const lichessMatch = url.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  if (lichessMatch) {
    return `lichess.org/${lichessMatch[1]}`;
  }
  return null;
}

/**
 * Extract platform info from the current URL
 * @returns {Object|null} { platform, platformGameId } or null
 */ function extractPlatformInfo() {
  const url = window.location.href;
  const chessComMatch = url.match(/chess\.com\/game\/(live|daily)\/(\d+)/);
  if (chessComMatch) {
    return {
      platform: "chess.com",
      platformGameId: chessComMatch[2]
    };
  }
  const lichessMatch = url.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  if (lichessMatch) {
    return {
      platform: "lichess",
      platformGameId: lichessMatch[1]
    };
  }
  // Fallback: detect platform from hostname even if game ID isn't in the URL
  // (chess.com may load games at /play/online or other paths)
    if (window.location.hostname.includes("chess.com")) {
    return {
      platform: "chess.com",
      platformGameId: null
    };
  }
  if (window.location.hostname.includes("lichess.org")) {
    return {
      platform: "lichess",
      platformGameId: null
    };
  }
  return null;
}

/**
 * Detect the player's color from board orientation
 * @returns {string|null} 'white' or 'black' or null
 */ function detectPlayerColorForTracking() {
  const board = findBoard();
  if (!board) return null;
  const flipped = isBoardFlipped(board);
  return flipped ? "black" : "white";
}

/**
 * Detect the opponent's name from chess.com or lichess UI
 * @returns {string|null} Opponent's username or null
 */ function detectOpponentName() {
  const board = findBoard();
  if (!board) return null;
  const flipped = isBoardFlipped(board);
  if (currentPlatform === "chess.com") {
    // Chess.com: player names are in elements near the board
    const playerSelectors = [ 
    // Top player (opponent if not flipped, us if flipped)
    {
      selector: sel().playerTop,
      isTop: true
    }, 
    // Bottom player (us if not flipped, opponent if flipped)
    {
      selector: sel().playerBottom,
      isTop: false
    } ];
    for (const {selector: selector, isTop: isTop} of playerSelectors) {
      const selectorList = selector.split(", ");
      for (const s of selectorList) {
        const el = document.querySelector(s);
        if (el) {
          const name = el.textContent.trim();
          if (name) {
            // Top is opponent when not flipped, us when flipped
            const isOpponent = isTop ? !flipped : flipped;
            if (isOpponent) return name;
          }
        }
      }
    }
  } else {
    // Lichess: player names in .ruser elements or name tags
    const lichessUsers = document.querySelectorAll(sel().players);
    if (lichessUsers.length >= 2) {
      // On lichess, top player = opponent when not flipped
      const opponentIndex = flipped ? 1 : 0;
      const name = lichessUsers[opponentIndex]?.textContent?.trim();
      if (name) return name;
    }
  }
  return null;
}

/**
 * Extract PGN from the current move list on the page
 * @returns {string|null} PGN string or null
 */ function extractPGN() {
  const moves = parseMoveList(true);
 // Force refresh
    if (moves.length === 0) return null;
  let pgn = "";
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      pgn += `${Math.floor(i / 2) + 1}. `;
    }
    pgn += moves[i].notation + " ";
  }
  return pgn.trim() || null;
}

/**
 * Extract win/loss/draw from a game-over DOM element.
 * Used to cache the result while the modal is still visible.
 * @param {Element} el - The game-over modal element
 * @returns {string|null} 'win', 'loss', or 'draw'
 */ function detectGameResultFromElement(el) {
  if (!el) return null;
  const text = el.textContent.toLowerCase();
  // Chess.com CSS class-based detection (most reliable — from their stylesheets):
  //   .game-over-header-userWon → current user won
  //   .game-over-header-whiteWon → white won
  //   .game-over-header-blackWon → black won
  //   .game-over-player-win → marks the winning player's row
    const header = el.closest?.(".game-over-header-component") || el.querySelector?.(".game-over-header-component") || el;
  if (header) {
    const cls = header.className || "";
    if (cls.includes("game-over-header-userWon")) return "win";
    // whiteWon/blackWon: map to our color
        if (cls.includes("game-over-header-whiteWon") || cls.includes("game-over-header-blackWon")) {
      const board = findBoard();
      if (board) {
        const flipped = isBoardFlipped(board);
        const ourColor = flipped ? "black" : "white";
        if (cls.includes("game-over-header-whiteWon")) return ourColor === "white" ? "win" : "loss";
        if (cls.includes("game-over-header-blackWon")) return ourColor === "black" ? "win" : "loss";
      }
    }
  }
  // Also check for .game-over-player-win on player rows
    const winPlayer = el.querySelector?.(".game-over-player-win");
  if (winPlayer) {
    const isWhiteWinner = winPlayer.querySelector?.(".game-over-player-white");
    const isBlackWinner = winPlayer.querySelector?.(".game-over-player-black");
    if (isWhiteWinner || isBlackWinner) {
      const board = findBoard();
      if (board) {
        const flipped = isBoardFlipped(board);
        const ourColor = flipped ? "black" : "white";
        if (isWhiteWinner) return ourColor === "white" ? "win" : "loss";
        if (isBlackWinner) return ourColor === "black" ? "win" : "loss";
      }
    }
  }
  // Text-based detection as fallback
    if (text.includes("you won") || text.includes("you win")) return "win";
  if (text.includes("you lost") || text.includes("you lose")) return "loss";
  const board = findBoard();
  if (board) {
    const flipped = isBoardFlipped(board);
    const ourColor = flipped ? "black" : "white";
    if (text.includes("white wins") || text.includes("white won") || text.includes("white is victorious")) {
      return ourColor === "white" ? "win" : "loss";
    }
    if (text.includes("black wins") || text.includes("black won") || text.includes("black is victorious")) {
      return ourColor === "black" ? "win" : "loss";
    }
    // Chess.com pattern: "<Username> won by checkmate/timeout/resignation"
        if (text.includes(" won")) {
      const headerEl = el.querySelector('[class*="header"], [class*="result"]');
      if (headerEl) {
        const headerText = headerEl.textContent.toLowerCase();
        if (headerText.includes("white")) return ourColor === "white" ? "win" : "loss";
        if (headerText.includes("black")) return ourColor === "black" ? "win" : "loss";
      }
    }
  }
  // Draw patterns
    if (text.includes("draw") || text.includes("drawn") || text.includes("stalemate") || text.includes("repetition") || text.includes("insufficient") || text.includes("agreement")) {
    return "draw";
  }
  // Chess.com result icon classes
    const winIcon = el.querySelector('[class*="win"], [class*="success"], [class*="green"]');
  const lossIcon = el.querySelector('[class*="lose"], [class*="loss"], [class*="red"]');
  if (winIcon) return "win";
  if (lossIcon) return "loss";
  return null;
}

/**
 * Detect the game result from the game-over UI
 * Returns 'win', 'loss', or 'draw' relative to the player
 * @param {string} reason - The game-over reason
 * @returns {string|null} 'win', 'loss', or 'draw'
 */ function detectGameResult(reason) {
  // Use cached result if we captured it when the modal was visible.
  // This is the primary fix for chess.com where the game-over modal
  // auto-dismisses before sendGameEnded() can read it.
  if (cachedGameResult) {
    _log("[Chess Helper] 📊 Using cached game result:", cachedGameResult);
    return cachedGameResult;
  }
  if (!reason) return null;
  // Draw conditions — deterministic from FEN, no DOM needed
    const drawReasons = [ "stalemate", "draw", "insufficient_material", "threefold_repetition" ];
  if (drawReasons.includes(reason)) return "draw";
  // Checkmate — winner is known from FEN analysis, no DOM needed.
  // gameEndWinner is 'white' or 'black', set by detectGameEndState().
    if (reason === "checkmate" && gameEndWinner) {
    const board = findBoard();
    if (board) {
      const flipped = isBoardFlipped(board);
      const ourColor = flipped ? "black" : "white";
      const result = gameEndWinner === ourColor ? "win" : "loss";
      _log("[Chess Helper] 📊 Result from FEN checkmate: winner=" + gameEndWinner + " ourColor=" + ourColor + " → " + result);
      return result;
    }
  }
  // Opponent left/aborted — try to detect from UI who left
    if (reason === "opponent_left" || reason === "aborted") {
    // Fall through to UI detection below to determine win/loss
  }
  // For resignation/timeout, we need DOM-based detection (chess.com only).
    for (const selector of sel().gameResult || []) {
    const el = document.querySelector(selector);
    if (el) {
      const result = detectGameResultFromElement(el);
      if (result) return result;
    }
  }
  // Lichess: check for result in status element
  // Lichess status text patterns (from translation source):
  //   "White is victorious", "Black is victorious"
  //   "White resigned", "Black resigned"
  //   "White time out", "Black time out"
  //   "White left the game", "Black left the game"
  //   "White didn't move", "Black didn't move"
  //   "Game aborted", "Draw", "Stalemate"
    const lichessStatus = queryFirst(sel().gameOver);
  if (lichessStatus) {
    const text = lichessStatus.textContent.toLowerCase();
    if (text.includes("draw") || text.includes("stalemate") || text.includes("fifty move")) return "draw";
    // Generic abort with no color info — no result
        if (text.includes("game aborted")) return null;
    // Determine our color from board orientation
        const board = findBoard();
    if (board) {
      const flipped = isBoardFlipped(board);
      const ourColor = flipped ? "black" : "white";
      // Helper: given the loser's color, determine our result
            const resultForLoser = loserColor => ourColor === loserColor ? "loss" : "win";
      // Victory messages: "White is victorious", "Black is victorious"
            if (text.includes("white is victorious") || text.includes("white wins")) {
        return ourColor === "white" ? "win" : "loss";
      }
      if (text.includes("black is victorious") || text.includes("black wins")) {
        return ourColor === "black" ? "win" : "loss";
      }
      // Resignation: "White resigned", "Black resigned"
            if (text.includes("white resigned")) return resultForLoser("white");
      if (text.includes("black resigned")) return resultForLoser("black");
      // Timeout: "White time out", "Black time out", "X ran out of time"
            if (text.includes("white time out") || text.includes("white ran out")) return resultForLoser("white");
      if (text.includes("black time out") || text.includes("black ran out")) return resultForLoser("black");
      // Inactivity: "White didn't move", "Black didn't move"
            if (text.includes("white didn't move") || text.includes("white did not move")) return resultForLoser("white");
      if (text.includes("black didn't move") || text.includes("black did not move")) return resultForLoser("black");
      // Left the game: "White left the game", "Black left the game"
            if (text.includes("white left")) return resultForLoser("white");
      if (text.includes("black left")) return resultForLoser("black");
    }
  }
  return null;
}

/**
 * Send game started event to the service worker (fire-and-forget)
 * Called when a new game is detected
 */ function sendGameStarted(retryCount = 0) {
  if (gameTrackingSent || !currentGameId) return;
  const platformInfo = extractPlatformInfo();
  if (!platformInfo) return;
  const tc = detectTimeControl();
  const playerColor = detectPlayerColorForTracking();
  const opponentName = detectOpponentName();
  // If time control wasn't detected yet (chess.com SPA may not have rendered clocks),
  // retry up to 5 times with increasing delay before sending without it.
  // Chess.com's SPA can take 3-8 seconds to fully render the game UI.
    if (!tc && retryCount < 5) {
    const retryDelays = [ 1500, 2e3, 3e3, 4e3, 5e3 ];
    const retryDelay = retryDelays[retryCount] || 3e3;
    _log(`[Chess Helper] 📊 Time control not detected, retrying in ${retryDelay}ms (attempt ${retryCount + 1}/5)`);
    setTimeout(() => sendGameStarted(retryCount + 1), retryDelay);
    return;
  }
  gameTrackingSent = true;
  safeSendMessage({
    type: "GAME_STARTED",
    gameId: currentGameId,
    platform: platformInfo.platform,
    platformGameId: platformInfo.platformGameId,
    timeControl: tc?.category || null,
    playerColor: playerColor,
    opponentName: opponentName
  });
  _log("[Chess Helper] 📊 Game tracking: GAME_STARTED sent", {
    gameId: currentGameId,
    platform: platformInfo.platform,
    timeControl: tc?.category,
    playerColor: playerColor,
    opponentName: opponentName
  });
}

/**
 * Send game ended event to the service worker (fire-and-forget)
 * Called when game over is detected or page is unloaded mid-game
 * @param {string} status - 'finished' or 'abandoned'
 */ function sendGameEnded(status = "finished") {
  if (!currentGameId || !gameTrackingSent) return;
  // Always try to detect result — even for "abandoned" games, the opponent may have
  // left/aborted which counts as a win for us on lichess.
    const result = detectGameResult(gameOverReason);
  // If we detected a result on what was going to be "abandoned", upgrade to "finished"
  // (e.g., opponent left the game on lichess — that's a completed game, not abandoned)
    if (status === "abandoned" && result) {
    status = "finished";
  }
  const pgn = extractPGN();
  // Try to detect timeControl now — by game end the UI is usually fully rendered.
  // This acts as a fallback if timeControl was null when GAME_STARTED was sent.
    const tc = detectTimeControl();
  safeSendMessage({
    type: "GAME_ENDED",
    gameId: currentGameId,
    result: result,
    status: status,
    pgn: pgn,
    lastFen: currentFen || null,
    timeControl: tc?.category || null
  });
  _log("[Chess Helper] 📊 Game tracking: GAME_ENDED sent", {
    gameId: currentGameId,
    result: result,
    status: status,
    timeControl: tc?.category,
    lastFen: currentFen ? currentFen.substring(0, 30) + "..." : null,
    pgn: pgn ? pgn.substring(0, 50) + "..." : null
  });
}

/**
 * Check if the URL has changed to a new game and reset state accordingly
 */ function checkForNewGameUrl() {
  const currentGamePath = extractGamePath();
  // If we're on a game page and the path changed, it's a new game
    if (currentGamePath && currentGamePath !== lastGameUrl) {
    _log("[Chess Helper] 🔄 New game URL detected:", currentGamePath);
    // If we had a previous game, send game ended (abandoned)
        if (lastGameUrl && gameTrackingSent) {
      sendGameEnded("abandoned");
    }
    lastGameUrl = currentGamePath;
    resetForNewGame({
      source: "checkForNewGameUrl",
      sendGameStartedDelay: true,
      resetUrlTracking: true,
      skipGameEnded: true
    });
  } else if (!currentGamePath && lastGameUrl) {
    // Navigated away from a game page
    if (gameTrackingSent) {
      sendGameEnded("abandoned");
    }
    lastGameUrl = null;
    gameTrackingSent = false;
  }
}

/**
 * Initialize the content script
 */ function init() {
  // Create AbortController for event listener cleanup
  eventListenerController = new AbortController;
  const signal = eventListenerController.signal;
  // Request current settings
    safeSendMessage({
    type: "GET_SETTINGS"
  });
  // Set up board observer when DOM is ready
    if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupBoardObserver, {
      signal: signal
    });
  } else {
    setupBoardObserver();
  }
  // Also watch for SPA navigation (chess.com uses client-side routing)
  // Track last known board state to prevent redundant setup calls
    let lastBoardState = !!findBoard();
  pageObserver = new MutationObserver(() => {
    const hasBoardNow = !!findBoard();
    // Only act if board state actually changed
        if (hasBoardNow !== lastBoardState) {
      _log("[Chess Helper] Board state changed:", lastBoardState ? "removed" : "appeared");
      lastBoardState = hasBoardNow;
      if (hasBoardNow && !pollingInterval) {
        // Board appeared and we're not polling yet
        setupBoardObserver();
      } else if (!hasBoardNow && pollingInterval) {
        // Board was removed (navigated away from game)
        cleanupState();
      }
    }
  });
  pageObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
  // Monitor URL changes for new game detection (SPA navigation)
    lastGameUrl = extractGamePath();
  // If we're already on a game page at init time (e.g. direct navigation, lichess),
  // generate a game ID and send GAME_STARTED after a delay to let DOM settle
    if (lastGameUrl && !gameTrackingSent) {
    if (!currentGameId) {
      generateNewGameId();
    }
    setTimeout(() => sendGameStarted(), 2e3);
  }
  // Listen for popstate (browser back/forward)
    window.addEventListener("popstate", () => {
    checkForNewGameUrl();
  }, {
    signal: signal
  });
  // Periodic URL check as fallback (every 2 seconds)
    const urlCheckInterval = setInterval(() => {
    checkForNewGameUrl();
  }, 2e3);
  // Clean up URL check interval on abort
    signal.addEventListener("abort", () => {
    clearInterval(urlCheckInterval);
  });
  // Clean up on page unload — also send game abandoned if mid-game
    window.addEventListener("beforeunload", () => {
    if (gameTrackingSent && !isGameOver) {
      sendGameEnded("abandoned");
    }
    fullCleanup();
  }, {
    signal: signal
  });
  // Handle visibility changes (optional optimization - pause when tab hidden)
    document.addEventListener("visibilitychange", () => {
    if (document.hidden && isAnalyzing) {
      // Tab became hidden, stop current analysis to save resources
      safeSendMessage({
        type: "STOP_ANALYSIS"
      });
      isAnalyzing = false;
      lastApiPosition = null;
    } else if (!document.hidden && currentFen && isAnalysisEnabled && !isGameOver) {
      // Tab became visible, restart analysis if we have a position
      requestAnalysis(currentFen, false);
    }
  }, {
    signal: signal
  });
  // Listen for pagehide event as backup (more reliable than beforeunload in some cases)
    window.addEventListener("pagehide", fullCleanup, {
    signal: signal
  });
  // Listen for autoplay toggle from overlay
    window.addEventListener("_xt", event => {
    const newEnabled = event.detail.enabled;
    _log("[Chess Helper] [Autoplay] Toggle requested:", newEnabled);
    // Update local state
        autoplayEnabled = newEnabled;
    if (newEnabled) {
      // Reset lastAutoplayedFen when enabling to allow fresh autoplay
      lastAutoplayedFen = null;
      autoplayExpectedTurn = null;
      autoplayMoveCount = null;
      // If we already have an analysis result for the current position, use it
            if (lastBestMove && lastBestMoveFen && lastBestMoveFen === currentFen) {
        scheduleAutoplay(lastBestMove, lastBestMoveFen);
      }
    } else {
      cancelAutoplay();
    }
    // Save to chrome.storage so popup and other tabs get updated
        try {
      chrome.storage.local.set({
        autoplayEnabled: newEnabled
      });
    } catch (e) {
      _err("[Chess Helper] Failed to save autoplay setting:", e);
    }
    // Dispatch settings update event to overlay
        window.dispatchEvent(new CustomEvent("_xs", {
      detail: {
        autoplayEnabled: newEnabled
      }
    }));
  }, {
    signal: signal
  });
  // Listen for antidetect toggle from overlay
    window.addEventListener("_xd", event => {
    const newEnabled = event.detail.enabled;
    _log("[Chess Helper] [Antidetect] Toggle requested:", newEnabled);
    antidetectEnabled = newEnabled;
    if (newEnabled) {
      rollNextWeakMoveThreshold();
    }
    // Save to chrome.storage so popup and other tabs get updated
        try {
      chrome.storage.local.set({
        antidetectEnabled: newEnabled
      });
    } catch (e) {
      _err("[Chess Helper] Failed to save antidetect setting:", e);
    }
    // Dispatch settings update event to overlay
        window.dispatchEvent(new CustomEvent("_xs", {
      detail: {
        antidetectEnabled: newEnabled
      }
    }));
  }, {
    signal: signal
  });
  // Listen for retry requests from overlay
    window.addEventListener("_xr", () => {
    if (currentFen) {
      _log("[Chess Helper] 🔄 Retry requested for FEN:", currentFen);
      lastApiPosition = null;
 // Clear dedup so retry goes through
            requestAnalysis(currentFen, false);
    }
  }, {
    signal: signal
  });
  // Listen for checkout requests from overlay (upgrade buttons)
    window.addEventListener("_xcheckout", async event => {
    const {priceId: priceId} = event.detail;
    _log("[Chess Helper] Checkout requested:", priceId);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "API_CHECKOUT",
        priceId: priceId
      });
      if (response?.success) {
        _log("[Chess Helper] Checkout URL opened in new tab");
        window.dispatchEvent(new CustomEvent("_xcheckout_result", {
          detail: {
            success: true
          }
        }));
      } else {
        _warn("[Chess Helper] Checkout failed:", response?.error);
        window.dispatchEvent(new CustomEvent("_xcheckout_result", {
          detail: {
            success: false,
            error: response?.error
          }
        }));
      }
    } catch (e) {
      _err("[Chess Helper] Checkout message failed:", e);
      window.dispatchEvent(new CustomEvent("_xcheckout_result", {
        detail: {
          success: false,
          error: "Connection error"
        }
      }));
    }
  }, {
    signal: signal
  });
}

// ============================================================
// DOM Health Monitoring
// ============================================================
const PERIODIC_HEALTH_INTERVAL = 150 * 60 * 1e3;

 // 2.5 hours (~10 reports/day)
const HEALTH_REPORT_COOLDOWN = 5 * 60 * 1e3;

 // 5 min throttle for failure reports
let _periodicHealthTimer = null;

const _healthReportTimestamps = {};

/**
 * Run a DOM health check validating all critical selectors
 * @returns {Object} Health report with check results
 */ function runDomHealthCheck() {
  const report = {
    platform: currentPlatform,
    url: window.location.hostname,
    extensionVersion: typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getManifest().version : "unknown",
    timestamp: Date.now(),
    checks: {}
  };
  // 1. Board element
    const board = queryFirst(sel().board);
  report.checks.boardFound = !!board;
  if (!board) return report;
  // 2. Shadow root (chess.com only)
    if (currentPlatform !== "lichess") {
    report.checks.shadowRootAccessible = !!board.shadowRoot;
  }
  // 3. Pieces
    const root = currentPlatform === "lichess" ? board : board.shadowRoot || board;
  const pieces = root.querySelectorAll(sel().pieces);
  report.checks.piecesFound = pieces.length;
  // 4. Piece class pattern valid
    if (pieces.length > 0) {
    const samplePiece = pieces[0];
    if (currentPlatform === "lichess") {
      report.checks.piecePositionReadable = !!samplePiece.style.transform;
    } else {
      const classes = Array.from(samplePiece.classList);
      report.checks.squareClassFound = classes.some(c => /^square-\d\d$/.test(c));
      report.checks.pieceClassFound = classes.some(c => /^[wb][pnbrqk]$/.test(c));
    }
  }
  // 5. Clock/turn detection
    const clockEl = document.querySelector(sel().clockActive);
  report.checks.clockFound = !!clockEl;
  // 6. Move list
    const moveList = queryFirst(sel().moveList);
  report.checks.moveListFound = !!moveList;
  return report;
}

/**
 * Send a DOM health report to the API via service worker
 * Periodic reports always send; failure reports are throttled to 1 per type per 5 min
 * @param {string} failureType - "periodic" | "board_not_found" | "no_pieces" | "pieces_timeout"
 */ function sendDomHealthReport(failureType) {
  // Throttle failure reports (not periodic)
  if (failureType !== "periodic") {
    const now = Date.now();
    const lastSent = _healthReportTimestamps[failureType] || 0;
    if (now - lastSent < HEALTH_REPORT_COOLDOWN) return;
    _healthReportTimestamps[failureType] = now;
  }
  const report = runDomHealthCheck();
  report.failureType = failureType;
  report.reportType = failureType === "periodic" ? "periodic" : "failure";
  _log("[Chess Helper] Sending DOM health report:", failureType, report.checks);
  try {
    chrome.runtime.sendMessage({
      type: "DOM_HEALTH_REPORT",
      report: report
    }).catch(() => {});
  } catch {
    // Extension context invalidated — ignore
  }
}

/**
 * Start periodic DOM health checks (~10 per day)
 * Called after board is found in setupBoardObserver()
 */ function startPeriodicHealthCheck() {
  if (_periodicHealthTimer) return;
  // Initial check after 30s (let page settle)
    setTimeout(() => sendDomHealthReport("periodic"), 3e4);
  _periodicHealthTimer = setInterval(() => {
    sendDomHealthReport("periodic");
  }, PERIODIC_HEALTH_INTERVAL);
}

// Start the content script
_log("[Chess Helper] 🎬 Initializing content script...");

init();

_log("[Chess Helper] ✅ Content script initialization complete!");