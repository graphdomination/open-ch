/**
 * Overlay System - SVG Arrow Rendering for Best Move Visualization
 *
 * This script renders visual overlays on the chess board (chess.com and
 * lichess.org) to show suggested moves as arrows and square highlights.
 */
// Debug logging shared from content.js (loaded first via manifest)
// Note: _log, _warn, _err are defined in content.js which loads first
// Overlay container reference
let overlayContainer = null;

let svgElement = null;

let evalDisplayElement = null;

let boardResizeObserver = null;

// Current overlay state
let currentArrow = null;

let currentHighlights = [];

let isOverlayVisible = true;

let currentEvaluation = null;

// Arrow styling constants - Animated Cyan theme
const ARROW_COLOR = "rgba(0, 220, 255, 0.95)";

const ARROW_COLOR_GLOW = "rgba(0, 220, 255, 0.5)";

const ARROW_COLOR_INNER = "rgba(180, 240, 255, 0.8)";

const ARROW_WIDTH = 10;

const ARROW_HEAD_SIZE = 24;

// Square highlight styling constants - Cyan
const HIGHLIGHT_COLOR_SOURCE = "rgba(0, 200, 255, 0.3)";

const HIGHLIGHT_COLOR_DESTINATION = "rgba(0, 220, 255, 0.45)";

// Arrow styling constants - Orange theme (weak/antidetect moves)
const ARROW_COLOR_WEAK = "rgba(255, 165, 0, 0.9)";

const HIGHLIGHT_COLOR_SOURCE_WEAK = "rgba(255, 165, 0, 0.3)";

const HIGHLIGHT_COLOR_DESTINATION_WEAK = "rgba(255, 165, 0, 0.45)";

const HIGHLIGHT_BORDER_WEAK = "rgba(255, 165, 0, 0.6)";

// Evaluation display styling constants
const EVAL_BACKGROUND_COLOR = "rgba(0, 0, 0, 0.75)";

const EVAL_TEXT_COLOR = "#ffffff";

const EVAL_POSITIVE_COLOR = "#4ade80";

 // Green for white advantage
const EVAL_NEGATIVE_COLOR = "#f87171";

 // Red for black advantage
const EVAL_NEUTRAL_COLOR = "#fbbf24";

 // Yellow for equal position
const EVAL_FONT_SIZE = 14;

const EVAL_PADDING = 6;

// Promotion piece indicator styling
const PROMOTION_INDICATOR_SIZE = 24;

const PROMOTION_BACKGROUND = "rgba(255, 255, 255, 0.95)";

const PROMOTION_BORDER = "rgba(0, 220, 255, 0.9)";

// Game over display styling
const GAME_OVER_BACKGROUND = "rgba(0, 0, 0, 0.8)";

const GAME_OVER_TEXT_COLOR = "#ffffff";

// Game over element reference
let gameOverElement = null;

// Promotion indicator element reference
let promotionIndicator = null;

// Status pill element reference (unified waiting/analyzing/error indicator)
let statusPill = null;

let statusPillState = null;

 // 'waiting' | 'analyzing' | 'error'
let statusPillTimeout = null;

 // Timeout for analyzing → error auto-switch
// Autoplay toggle element reference
let autoplayToggle = null;

// Antidetect toggle element reference
let antidetectToggle = null;

// Weak move display state (orange colors when true)
let isWeakMoveDisplay = false;

// Antidetect enabled state
let isAntidetectEnabled = false;

let isAutoplayEnabled = false;

/**
 * Convert algebraic notation (e.g., 'e2') to file/rank numbers
 * @param {string} square - Algebraic notation square (e.g., 'e2')
 * @returns {Object} Object with file (1-8) and rank (1-8)
 */ function algebraicToCoords(square) {
  if (!square || square.length < 2) {
    return null;
  }
  const file = square.charCodeAt(0) - "a".charCodeAt(0) + 1;
 // a=1, b=2, ..., h=8
    const rank = parseInt(square[1], 10);
 // 1-8
    if (file < 1 || file > 8 || rank < 1 || rank > 8) {
    return null;
  }
  return {
    file: file,
    rank: rank
  };
}

/**
 * Parse a UCI move string (e.g., 'e2e4' or 'e7e8q') to from/to squares
 * @param {string} move - UCI format move
 * @returns {Object|null} Object with from and to squares, plus optional promotion
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
 * Detect if a move is a castling move
 * @param {Object} move - Parsed move object from parseUciMove
 * @returns {Object|null} Castling info with type and rook squares, or null if not castling
 */ function detectCastling(move) {
  if (!move) return null;
  const {from: from, to: to} = move;
  // King starting positions
    const isWhiteKing = from.square === "e1";
  const isBlackKing = from.square === "e8";
  if (!isWhiteKing && !isBlackKing) {
    return null;
  }
  // White kingside: e1g1 (rook h1 to f1)
    if (from.square === "e1" && to.square === "g1") {
    return {
      type: "kingside",
      color: "white",
      rookFrom: {
        square: "h1",
        file: 8,
        rank: 1
      },
      rookTo: {
        square: "f1",
        file: 6,
        rank: 1
      }
    };
  }
  // White queenside: e1c1 (rook a1 to d1)
    if (from.square === "e1" && to.square === "c1") {
    return {
      type: "queenside",
      color: "white",
      rookFrom: {
        square: "a1",
        file: 1,
        rank: 1
      },
      rookTo: {
        square: "d1",
        file: 4,
        rank: 1
      }
    };
  }
  // Black kingside: e8g8 (rook h8 to f8)
    if (from.square === "e8" && to.square === "g8") {
    return {
      type: "kingside",
      color: "black",
      rookFrom: {
        square: "h8",
        file: 8,
        rank: 8
      },
      rookTo: {
        square: "f8",
        file: 6,
        rank: 8
      }
    };
  }
  // Black queenside: e8c8 (rook a8 to d8)
    if (from.square === "e8" && to.square === "c8") {
    return {
      type: "queenside",
      color: "black",
      rookFrom: {
        square: "a8",
        file: 1,
        rank: 8
      },
      rookTo: {
        square: "d8",
        file: 4,
        rank: 8
      }
    };
  }
  return null;
}

/**
 * Get the Unicode symbol for a promotion piece
 * @param {string} piece - Piece letter (q, r, b, n)
 * @param {boolean} isWhite - Whether the piece is white
 * @returns {string} Unicode chess piece symbol
 */ function getPromotionSymbol(piece, isWhite) {
  const symbols = {
    white: {
      q: "♕",
      r: "♖",
      b: "♗",
      n: "♘"
    },
    black: {
      q: "♛",
      r: "♜",
      b: "♝",
      n: "♞"
    }
  };
  const color = isWhite ? "white" : "black";
  return symbols[color][piece.toLowerCase()] || symbols[color].q;
}

/**
 * Get the board element and its dimensions
 * @returns {Object|null} Board info with element, size, and position
 */ function getBoardInfo() {
  const platform = window._chPlatform || "chess.com";
  const s = SELECTORS[platform];
  // Use centralized selector registry from content.js
    const board = queryFirst(s.board);
  if (!board) {
    return null;
  }
  const rect = board.getBoundingClientRect();
  let isFlipped;
  if (platform === "lichess") {
    const cgWrap = board.closest(s.boardWrapper);
    isFlipped = cgWrap ? cgWrap.classList.contains(s.flippedClass) : false;
  } else {
    isFlipped = board.classList.contains("flipped") || board.hasAttribute("flipped") || board.dataset?.flipped === "true" || board.getAttribute("orientation") === "black";
  }
  return {
    element: board,
    rect: rect,
    squareSize: rect.width / 8,
    isFlipped: isFlipped
  };
}

/**
 * Convert board coordinates to pixel position (center of square)
 * @param {number} file - File number (1-8)
 * @param {number} rank - Rank number (1-8)
 * @param {Object} boardInfo - Board information from getBoardInfo()
 * @returns {Object} Pixel coordinates {x, y} relative to board
 */ function coordsToPixels(file, rank, boardInfo) {
  const {squareSize: squareSize, isFlipped: isFlipped} = boardInfo;
  let pixelFile, pixelRank;
  if (isFlipped) {
    // When flipped, a1 is top-right, h8 is bottom-left
    pixelFile = (8 - file) * squareSize + squareSize / 2;
    pixelRank = (rank - 1) * squareSize + squareSize / 2;
  } else {
    // Normal orientation, a1 is bottom-left, h8 is top-right
    pixelFile = (file - 1) * squareSize + squareSize / 2;
    pixelRank = (8 - rank) * squareSize + squareSize / 2;
  }
  return {
    x: pixelFile,
    y: pixelRank
  };
}

/**
 * Convert board coordinates to pixel position (top-left corner of square)
 * @param {number} file - File number (1-8)
 * @param {number} rank - Rank number (1-8)
 * @param {Object} boardInfo - Board information from getBoardInfo()
 * @returns {Object} Pixel coordinates {x, y} relative to board
 */ function coordsToSquareCorner(file, rank, boardInfo) {
  const {squareSize: squareSize, isFlipped: isFlipped} = boardInfo;
  let pixelFile, pixelRank;
  if (isFlipped) {
    // When flipped, a1 is top-right, h8 is bottom-left
    pixelFile = (8 - file) * squareSize;
    pixelRank = (rank - 1) * squareSize;
  } else {
    // Normal orientation, a1 is bottom-left, h8 is top-right
    pixelFile = (file - 1) * squareSize;
    pixelRank = (8 - rank) * squareSize;
  }
  return {
    x: pixelFile,
    y: pixelRank
  };
}

/**
 * Draw a square highlight on the SVG overlay
 * @param {string} square - Square in algebraic notation (e.g., 'e2')
 * @param {string} color - Fill color for the highlight
 * @returns {SVGRectElement|null} The created rect element or null on failure
 */ function drawSquareHighlight(square, color) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) {
    return null;
  }
  const coords = algebraicToCoords(square);
  if (!coords) {
    return null;
  }
  // Ensure overlay exists
    if (!svgElement || !document.contains(svgElement)) {
    createOverlayContainer(boardInfo.element);
    const rect = boardInfo.rect;
    svgElement.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  }
  // Get top-left corner of square
    const corner = coordsToSquareCorner(coords.file, coords.rank, boardInfo);
  const size = boardInfo.squareSize;
  // Create highlight group for layered effect
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.classList.add("_xhl");
  // Main fill rectangle
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", corner.x);
  rect.setAttribute("y", corner.y);
  rect.setAttribute("width", size);
  rect.setAttribute("height", size);
  rect.setAttribute("fill", color);
  group.appendChild(rect);
  // Border rectangle (inner glow effect)
    const border = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  const borderInset = 2;
  border.setAttribute("x", corner.x + borderInset);
  border.setAttribute("y", corner.y + borderInset);
  border.setAttribute("width", size - borderInset * 2);
  border.setAttribute("height", size - borderInset * 2);
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", isWeakMoveDisplay ? HIGHLIGHT_BORDER_WEAK : "rgba(0, 220, 255, 0.6)");
  border.setAttribute("stroke-width", "2");
  border.setAttribute("rx", "3");
  group.appendChild(border);
  // Insert highlight before arrows (so arrows render on top)
    const firstArrow = svgElement.querySelector("._xar");
  if (firstArrow) {
    svgElement.insertBefore(group, firstArrow);
  } else {
    svgElement.appendChild(group);
  }
  return group;
}

/**
 * Draw highlights for source and destination squares
 * @param {string} fromSquare - Source square in algebraic notation
 * @param {string} toSquare - Destination square in algebraic notation
 */ function drawHighlights(fromSquare, toSquare) {
  // Clear existing highlights first
  clearHighlights();
  // Draw source square highlight (orange for weak/antidetect moves)
    const srcColor = isWeakMoveDisplay ? HIGHLIGHT_COLOR_SOURCE_WEAK : HIGHLIGHT_COLOR_SOURCE;
  const sourceHighlight = drawSquareHighlight(fromSquare, srcColor);
  if (sourceHighlight) {
    currentHighlights.push(sourceHighlight);
  }
  // Draw destination square highlight with pulsing animation (orange for weak/antidetect moves)
    const dstColor = isWeakMoveDisplay ? HIGHLIGHT_COLOR_DESTINATION_WEAK : HIGHLIGHT_COLOR_DESTINATION;
  const destHighlight = drawSquareHighlight(toSquare, dstColor);
  if (destHighlight) {
    destHighlight.classList.add("_xhp");
    currentHighlights.push(destHighlight);
  }
}

/**
 * Clear all square highlights from the overlay
 */ function clearHighlights() {
  // Remove tracked highlights
  currentHighlights.forEach(highlight => {
    if (highlight && highlight.parentNode) {
      highlight.parentNode.removeChild(highlight);
    }
  });
  currentHighlights = [];
  // Also clear any highlights by class (safety net)
    if (svgElement) {
    const highlights = svgElement.querySelectorAll("._xhl");
    highlights.forEach(highlight => highlight.remove());
  }
}

/**
 * Format evaluation score for display
 * @param {Object} evaluation - Evaluation object with type and value
 * @returns {Object} Formatted evaluation with text and color
 */ function formatEvaluation(evaluation) {
  if (!evaluation) {
    return {
      text: "...",
      color: EVAL_NEUTRAL_COLOR
    };
  }
  const {type: type, value: value} = evaluation;
  if (type === "mate") {
    // Mate in X moves
    const sign = value > 0 ? "+" : "";
    return {
      text: `${sign}M${Math.abs(value)}`,
      color: value > 0 ? EVAL_POSITIVE_COLOR : EVAL_NEGATIVE_COLOR
    };
  }
  if (type === "cp") {
    // Centipawns - convert to pawns (divide by 100)
    const pawns = value / 100;
    const absValue = Math.abs(pawns);
    // Determine color based on value
        let color;
    if (absValue < .3) {
      color = EVAL_NEUTRAL_COLOR;
 // Roughly equal
        } else if (pawns > 0) {
      color = EVAL_POSITIVE_COLOR;
 // White advantage
        } else {
      color = EVAL_NEGATIVE_COLOR;
 // Black advantage
        }
    // Format the number
        const sign = pawns > 0 ? "+" : "";
    const formatted = absValue >= 10 ? absValue.toFixed(0) : absValue.toFixed(1);
    return {
      text: `${sign}${pawns < 0 ? "-" : ""}${formatted}`,
      color: color
    };
  }
  return {
    text: "?",
    color: EVAL_NEUTRAL_COLOR
  };
}

/**
 * Create or update the evaluation display element
 * @param {Object} evaluation - Evaluation object with type and value
 */ function updateEvalDisplay(evaluation) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) {
    return;
  }
  // Store current evaluation
    currentEvaluation = evaluation;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Format the evaluation
    const {text: text, color: color} = formatEvaluation(evaluation);
  // Create or update eval display element
    if (!evalDisplayElement || !document.contains(evalDisplayElement)) {
    evalDisplayElement = document.createElement("div");
    evalDisplayElement.id = "_xv";
    evalDisplayElement.style.cssText = `\n      position: absolute;\n      top: 8px;\n      right: 8px;\n      padding: ${EVAL_PADDING}px ${EVAL_PADDING * 1.5}px;\n      background: ${EVAL_BACKGROUND_COLOR};\n      border-radius: 4px;\n      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n      font-size: ${EVAL_FONT_SIZE}px;\n      font-weight: 600;\n      color: ${EVAL_TEXT_COLOR};\n      pointer-events: none;\n      z-index: 101;\n      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);\n      transition: color 0.2s ease;\n    `;
    overlayContainer.appendChild(evalDisplayElement);
  }
  // Update the display
    evalDisplayElement.textContent = text;
  evalDisplayElement.style.color = color;
}

/**
 * Clear the evaluation display
 */ function clearEvalDisplay() {
  currentEvaluation = null;
  if (evalDisplayElement && evalDisplayElement.parentNode) {
    evalDisplayElement.parentNode.removeChild(evalDisplayElement);
    evalDisplayElement = null;
  }
}

/**
 * Draw a promotion indicator at the destination square
 * @param {string} toSquare - Destination square in algebraic notation
 * @param {string} promotionPiece - Piece to promote to (q, r, b, n)
 * @param {boolean} isWhite - Whether the promoting player is white
 */ function drawPromotionIndicator(toSquare, promotionPiece, isWhite) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) return;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Clear any existing promotion indicator
    clearPromotionIndicator();
  const coords = algebraicToCoords(toSquare);
  if (!coords) return;
  // Get pixel position (corner of square)
    const corner = coordsToSquareCorner(coords.file, coords.rank, boardInfo);
  // Create indicator element
    promotionIndicator = document.createElement("div");
  promotionIndicator.id = "_xp";
  promotionIndicator.style.cssText = `\n    position: absolute;\n    left: ${corner.x + boardInfo.squareSize - PROMOTION_INDICATOR_SIZE - 4}px;\n    top: ${corner.y + 4}px;\n    width: ${PROMOTION_INDICATOR_SIZE}px;\n    height: ${PROMOTION_INDICATOR_SIZE}px;\n    background: ${PROMOTION_BACKGROUND};\n    border: 2px solid ${PROMOTION_BORDER};\n    border-radius: 4px;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    font-size: ${PROMOTION_INDICATOR_SIZE - 6}px;\n    line-height: 1;\n    pointer-events: none;\n    z-index: 102;\n    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);\n  `;
  // Add the piece symbol
    promotionIndicator.textContent = getPromotionSymbol(promotionPiece, isWhite);
  overlayContainer.appendChild(promotionIndicator);
}

/**
 * Clear the promotion indicator
 */ function clearPromotionIndicator() {
  if (promotionIndicator && promotionIndicator.parentNode) {
    promotionIndicator.parentNode.removeChild(promotionIndicator);
    promotionIndicator = null;
  }
}

/**
 * Show game over status
 * @param {string} reason - The reason the game ended
 * @param {string} winner - The winner ('white', 'black', or null for draw)
 */ function showGameOver(reason, winner) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) return;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Clear any existing game over display
    clearGameOver();
  // Format the game over message
    let message = "";
  switch (reason) {
   case "checkmate":
    message = winner ? `Checkmate - ${winner.charAt(0).toUpperCase() + winner.slice(1)} wins` : "Checkmate";
    break;

   case "stalemate":
    message = "Stalemate - Draw";
    break;

   case "insufficient_material":
    message = "Draw - Insufficient Material";
    break;

   case "threefold_repetition":
    message = "Draw - Threefold Repetition";
    break;

   case "draw":
    message = "Draw";
    break;

   case "resignation":
    message = "Resignation";
    break;

   case "timeout":
    message = "Timeout";
    break;

   case "abandoned":
    message = "Game Abandoned";
    break;

   default:
    message = "Game Over";
  }
  // Create game over element
    gameOverElement = document.createElement("div");
  gameOverElement.id = "_xg";
  gameOverElement.style.cssText = `\n    position: absolute;\n    bottom: 8px;\n    left: 50%;\n    transform: translateX(-50%);\n    padding: 8px 16px;\n    background: ${GAME_OVER_BACKGROUND};\n    color: ${GAME_OVER_TEXT_COLOR};\n    border-radius: 4px;\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    font-size: 14px;\n    font-weight: 600;\n    pointer-events: none;\n    z-index: 103;\n    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);\n    white-space: nowrap;\n  `;
  gameOverElement.textContent = message;
  overlayContainer.appendChild(gameOverElement);
}

/**
 * Clear the game over display
 */ function clearGameOver() {
  if (gameOverElement && gameOverElement.parentNode) {
    gameOverElement.parentNode.removeChild(gameOverElement);
    gameOverElement = null;
  }
}

/**
 * Show the unified status pill in the top-right corner.
 * @param {'waiting'|'analyzing'|'error'} state
 * @param {Object} [options]
 * @param {string} [options.error] - Error message (for 'error' state)
 */ function showStatusPill(state, options = {}) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) return;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Clear existing pill
    clearStatusPill();
  // For waiting and analyzing states, clear stale analysis display
    if (state === "waiting" || state === "analyzing") {
    clearArrow();
    clearEvalDisplay();
  }
  // Add CSS animations if not already present
    if (!document.getElementById("_xws")) {
    const style = document.createElement("style");
    style.id = "_xws";
    style.textContent = `\n      @keyframes _k1 {\n        0%, 100% { opacity: 1; transform: scale(1); }\n        50% { opacity: 0.5; transform: scale(0.8); }\n      }\n      @keyframes _k2spin {\n        0% { transform: rotate(0deg); }\n        100% { transform: rotate(360deg); }\n      }\n    `;
    document.head.appendChild(style);
  }
  const isError = state === "error";
  statusPill = document.createElement("div");
  statusPill.id = "_xsp";
  statusPill.style.cssText = `\n    position: absolute;\n    top: 8px;\n    right: 8px;\n    padding: 6px 12px;\n    background: rgba(0, 0, 0, 0.75);\n    border-radius: 4px;\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    font-size: 12px;\n    font-weight: 500;\n    color: ${isError ? "#ffffff" : "#fbbf24"};\n    pointer-events: ${isError ? "auto" : "none"};\n    cursor: ${isError ? "pointer" : "default"};\n    z-index: 101;\n    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    ${isError ? "border: 1px solid rgba(255, 255, 255, 0.15); transition: background 0.2s ease;" : ""}\n  `;
  // Create dot indicator
    const dot = document.createElement("span");
  if (state === "waiting") {
    dot.style.cssText = `\n      width: 8px;\n      height: 8px;\n      background: #f87171;\n      border-radius: 50%;\n      animation: _k1 1.5s ease-in-out infinite;\n    `;
  } else if (state === "analyzing") {
    dot.style.cssText = `\n      width: 8px;\n      height: 8px;\n      border: 2px solid transparent;\n      border-top: 2px solid #fbbf24;\n      border-right: 2px solid #fbbf24;\n      border-radius: 50%;\n      animation: _k2spin 0.8s linear infinite;\n      box-sizing: border-box;\n    `;
  } else {
    // error
    dot.style.cssText = `\n      width: 8px;\n      height: 8px;\n      background: #f87171;\n      border-radius: 50%;\n    `;
  }
  statusPill.appendChild(dot);
  // Create text content
    if (state === "waiting") {
    statusPill.appendChild(document.createTextNode("Waiting..."));
  } else if (state === "analyzing") {
    statusPill.appendChild(document.createTextNode("Analyzing..."));
  } else {
    // Error state: error message + retry text
    const errorText = document.createElement("span");
    errorText.textContent = options.error || "Analysis failed";
    errorText.style.cssText = "font-size: 10px; opacity: 0.7;";
    statusPill.appendChild(errorText);
    const retryText = document.createElement("span");
    retryText.textContent = "↻ Retry";
    retryText.style.cssText = "font-weight: 600; margin-left: 4px;";
    statusPill.appendChild(retryText);
    // Hover effects
        statusPill.addEventListener("mouseenter", () => {
      statusPill.style.background = "rgba(0, 0, 0, 0.95)";
    });
    statusPill.addEventListener("mouseleave", () => {
      statusPill.style.background = "rgba(0, 0, 0, 0.75)";
    });
    // Click handler: retry
        statusPill.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      showStatusPill("analyzing");
      window.dispatchEvent(new CustomEvent("_xr"));
    });
  }
  overlayContainer.appendChild(statusPill);
  statusPillState = state;
  // Set timeout for analyzing state: auto-switch to error after 15s
    if (state === "analyzing") {
    statusPillTimeout = setTimeout(() => {
      if (statusPillState === "analyzing") {
        showStatusPill("error", {
          error: "Request timed out"
        });
      }
    }, 15e3);
  }
}

/**
 * Clear the status pill and any associated timeout
 */ function clearStatusPill() {
  if (statusPillTimeout) {
    clearTimeout(statusPillTimeout);
    statusPillTimeout = null;
  }
  if (statusPill && statusPill.parentNode) {
    statusPill.parentNode.removeChild(statusPill);
    statusPill = null;
  }
  statusPillState = null;
}

/**
 * Create or update the autoplay toggle button
 * @param {boolean} enabled - Whether autoplay is currently enabled
 */ function createAutoplayToggle(enabled) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) return;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Update state
    isAutoplayEnabled = enabled;
  // If toggle already exists, just update it
    if (autoplayToggle && document.contains(autoplayToggle)) {
    updateAutoplayToggleState(enabled);
    return;
  }
  // Create the toggle element
    autoplayToggle = document.createElement("div");
  autoplayToggle.id = "_xat";
  autoplayToggle.style.cssText = `\n    position: absolute;\n    top: 8px;\n    left: 8px;\n    padding: 6px 12px;\n    background: rgba(0, 0, 0, 0.75);\n    border-radius: 4px;\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    font-size: 12px;\n    font-weight: 500;\n    color: #ffffff;\n    cursor: pointer;\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    z-index: 1000;\n    user-select: none;\n    transition: background 0.2s ease;\n    pointer-events: auto;\n  `;
  // Create status dot
    const dot = document.createElement("span");
  dot.className = "_xsd";
  dot.style.cssText = `\n    width: 8px;\n    height: 8px;\n    border-radius: 50%;\n    background: ${enabled ? "#4ade80" : "#f87171"};\n    transition: background 0.2s ease;\n  `;
  // Create label
    const label = document.createElement("span");
  label.textContent = "Autoplay";
  autoplayToggle.appendChild(dot);
  autoplayToggle.appendChild(label);
  // Add hover effect
    autoplayToggle.addEventListener("mouseenter", () => {
    autoplayToggle.style.background = "rgba(0, 0, 0, 0.9)";
  });
  autoplayToggle.addEventListener("mouseleave", () => {
    autoplayToggle.style.background = "rgba(0, 0, 0, 0.75)";
  });
  // Add click handler
    autoplayToggle.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    // Dispatch event to toggle autoplay in content.js
        window.dispatchEvent(new CustomEvent("_xt", {
      detail: {
        enabled: !isAutoplayEnabled
      }
    }));
  });
  overlayContainer.appendChild(autoplayToggle);
}

/**
 * Update the autoplay toggle state (dot color)
 * @param {boolean} enabled - Whether autoplay is enabled
 */ function updateAutoplayToggleState(enabled) {
  isAutoplayEnabled = enabled;
  if (autoplayToggle) {
    const dot = autoplayToggle.querySelector("._xsd");
    if (dot) {
      dot.style.background = enabled ? "#4ade80" : "#f87171";
    }
  }
}

/**
 * Remove the autoplay toggle
 */ function clearAutoplayToggle() {
  if (autoplayToggle && autoplayToggle.parentNode) {
    autoplayToggle.parentNode.removeChild(autoplayToggle);
    autoplayToggle = null;
  }
}

/**
 * Create or update the antidetect toggle button
 * @param {boolean} enabled - Whether antidetect is currently enabled
 */ function createAntidetectToggle(enabled) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) return;
  // Ensure overlay container exists
    if (!overlayContainer || !document.contains(overlayContainer)) {
    createOverlayContainer(boardInfo.element);
  }
  // Update state
    isAntidetectEnabled = enabled;
  // If toggle already exists, just update it
    if (antidetectToggle && document.contains(antidetectToggle)) {
    updateAntidetectToggleState(enabled);
    return;
  }
  // Create the toggle element
    antidetectToggle = document.createElement("div");
  antidetectToggle.id = "_xdt";
  antidetectToggle.style.cssText = `\n    position: absolute;\n    top: 8px;\n    left: 100px;\n    padding: 6px 12px;\n    background: rgba(0, 0, 0, 0.75);\n    border-radius: 4px;\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    font-size: 12px;\n    font-weight: 500;\n    color: #ffffff;\n    cursor: pointer;\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    z-index: 1000;\n    user-select: none;\n    transition: background 0.2s ease;\n    pointer-events: auto;\n  `;
  // Create status dot
    const dot = document.createElement("span");
  dot.className = "_xdd";
  dot.style.cssText = `\n    width: 8px;\n    height: 8px;\n    border-radius: 50%;\n    background: ${enabled ? "#4ade80" : "#f59e0b"};\n    transition: background 0.2s ease;\n  `;
  // Create label
    const label = document.createElement("span");
  label.textContent = "AD";
  antidetectToggle.appendChild(dot);
  antidetectToggle.appendChild(label);
  // Add hover effect
    antidetectToggle.addEventListener("mouseenter", () => {
    antidetectToggle.style.background = "rgba(0, 0, 0, 0.9)";
  });
  antidetectToggle.addEventListener("mouseleave", () => {
    antidetectToggle.style.background = "rgba(0, 0, 0, 0.75)";
  });
  // Add click handler
    antidetectToggle.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    // Dispatch event to toggle antidetect in content.js
        window.dispatchEvent(new CustomEvent("_xd", {
      detail: {
        enabled: !isAntidetectEnabled
      }
    }));
  });
  overlayContainer.appendChild(antidetectToggle);
}

/**
 * Update the antidetect toggle state (dot color)
 * @param {boolean} enabled - Whether antidetect is enabled
 */ function updateAntidetectToggleState(enabled) {
  isAntidetectEnabled = enabled;
  if (antidetectToggle) {
    const dot = antidetectToggle.querySelector("._xdd");
    if (dot) {
      dot.style.background = enabled ? "#4ade80" : "#f59e0b";
    }
  }
}

/**
 * Remove the antidetect toggle
 */ function clearAntidetectToggle() {
  if (antidetectToggle && antidetectToggle.parentNode) {
    antidetectToggle.parentNode.removeChild(antidetectToggle);
    antidetectToggle = null;
  }
}

/**
 * Draw a secondary arrow for castling (shows rook movement)
 * @param {Object} castlingInfo - Castling info from detectCastling
 * @param {Object} boardInfo - Board info from getBoardInfo
 */ function drawCastlingRookArrow(castlingInfo, boardInfo) {
  if (!castlingInfo || !svgElement) return;
  const {rookFrom: rookFrom, rookTo: rookTo} = castlingInfo;
  // Calculate pixel positions
    const fromPixels = coordsToPixels(rookFrom.file, rookFrom.rank, boardInfo);
  const toPixels = coordsToPixels(rookTo.file, rookTo.rank, boardInfo);
  // Calculate adjusted path
    const path = calculateArrowPath(fromPixels, toPixels, boardInfo.squareSize);
  // Create secondary arrow line (thinner, animated dashes)
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", path.fromX);
  line.setAttribute("y1", path.fromY);
  line.setAttribute("x2", path.toX);
  line.setAttribute("y2", path.toY);
  line.setAttribute("stroke", "rgba(0, 200, 255, 0.7)");
  line.setAttribute("stroke-width", ARROW_WIDTH * .5);
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-dasharray", "8,6");
  line.classList.add("_xar", "_xra", "_xaf");
  // Insert before main arrow
    const mainArrow = svgElement.querySelector("._xar:not(._xra)");
  if (mainArrow) {
    svgElement.insertBefore(line, mainArrow);
  } else {
    svgElement.appendChild(line);
  }
  // Add rook highlight
    drawSquareHighlight(rookFrom.square, "rgba(0, 200, 255, 0.2)");
}

/**
 * Create the SVG overlay container
 * @param {Element} board - The board element
 * @returns {SVGElement} The SVG element
 */ function createOverlayContainer(board) {
  // Remove existing overlay if present
  removeOverlay();
  const boardRect = board.getBoundingClientRect();
  const platform = window._chPlatform || "chess.com";
  // For Lichess, use .cg-wrap as parent (already has position: relative)
    let boardParent;
  if (platform === "lichess") {
    boardParent = board.closest(".cg-wrap") || board.parentElement;
  } else {
    boardParent = board.parentElement;
  }
  // Calculate board's offset relative to its parent
    let offsetLeft = 0;
  let offsetTop = 0;
  if (boardParent) {
    const parentRect = boardParent.getBoundingClientRect();
    offsetLeft = boardRect.left - parentRect.left;
    offsetTop = boardRect.top - parentRect.top;
  }
  // Create container div - positioned exactly over the board
    overlayContainer = document.createElement("div");
  overlayContainer.id = "_xo";
  overlayContainer.style.cssText = `\n    position: absolute;\n    top: ${offsetTop}px;\n    left: ${offsetLeft}px;\n    width: ${boardRect.width}px;\n    height: ${boardRect.height}px;\n    pointer-events: none;\n    z-index: 100;\n  `;
  // Create SVG element
    svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgElement.setAttribute("width", "100%");
  svgElement.setAttribute("height", "100%");
  svgElement.setAttribute("viewBox", `0 0 ${boardRect.width} ${boardRect.height}`);
  svgElement.style.cssText = `\n    position: absolute;\n    top: 0;\n    left: 0;\n    overflow: visible;\n  `;
  // Add CSS animations for arrow effects
    if (!document.getElementById("_xas")) {
    const style = document.createElement("style");
    style.id = "_xas";
    style.textContent = `\n      @keyframes _xaf {\n        0% { stroke-dashoffset: 30; }\n        100% { stroke-dashoffset: 0; }\n      }\n      @keyframes _k3 {\n        0%, 100% { opacity: 0.9; filter: url(#arrow-glow); }\n        50% { opacity: 1; filter: url(#arrow-glow-strong); }\n      }\n      @keyframes _k4 {\n        0%, 100% { opacity: 0.4; }\n        50% { opacity: 0.7; }\n      }\n      ._xaa {\n        animation: _k3 1.5s ease-in-out infinite;\n      }\n      ._xaf {\n        animation: _xaf 0.8s linear infinite;\n      }\n      ._xag {\n        animation: _k4 1.5s ease-in-out infinite;\n      }\n    `;
    document.head.appendChild(style);
  }
  // Add arrow marker definitions with glow effect
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  // Standard glow filter
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
  filter.setAttribute("id", "arrow-glow");
  filter.setAttribute("x", "-100%");
  filter.setAttribute("y", "-100%");
  filter.setAttribute("width", "300%");
  filter.setAttribute("height", "300%");
  const feGaussianBlur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
  feGaussianBlur.setAttribute("stdDeviation", "4");
  feGaussianBlur.setAttribute("result", "coloredBlur");
  const feMerge = document.createElementNS("http://www.w3.org/2000/svg", "feMerge");
  const feMergeNode1 = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
  feMergeNode1.setAttribute("in", "coloredBlur");
  const feMergeNode2 = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
  feMergeNode2.setAttribute("in", "SourceGraphic");
  feMerge.appendChild(feMergeNode1);
  feMerge.appendChild(feMergeNode2);
  filter.appendChild(feGaussianBlur);
  filter.appendChild(feMerge);
  defs.appendChild(filter);
  // Strong glow filter for pulse animation
    const filterStrong = document.createElementNS("http://www.w3.org/2000/svg", "filter");
  filterStrong.setAttribute("id", "arrow-glow-strong");
  filterStrong.setAttribute("x", "-100%");
  filterStrong.setAttribute("y", "-100%");
  filterStrong.setAttribute("width", "300%");
  filterStrong.setAttribute("height", "300%");
  const feBlurStrong = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
  feBlurStrong.setAttribute("stdDeviation", "6");
  feBlurStrong.setAttribute("result", "coloredBlur");
  const feMergeStrong = document.createElementNS("http://www.w3.org/2000/svg", "feMerge");
  const feMergeNodeS1 = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
  feMergeNodeS1.setAttribute("in", "coloredBlur");
  const feMergeNodeS2 = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
  feMergeNodeS2.setAttribute("in", "coloredBlur");
  const feMergeNodeS3 = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
  feMergeNodeS3.setAttribute("in", "SourceGraphic");
  feMergeStrong.appendChild(feMergeNodeS1);
  feMergeStrong.appendChild(feMergeNodeS2);
  feMergeStrong.appendChild(feMergeNodeS3);
  filterStrong.appendChild(feBlurStrong);
  filterStrong.appendChild(feMergeStrong);
  defs.appendChild(filterStrong);
  // Arrow marker (arrowhead) - sleek triangle
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "14");
  marker.setAttribute("markerHeight", "10");
  marker.setAttribute("refX", "12");
  marker.setAttribute("refY", "5");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "strokeWidth");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", "0 0, 14 5, 0 10, 3 5");
  polygon.setAttribute("fill", ARROW_COLOR);
  marker.appendChild(polygon);
  defs.appendChild(marker);
  svgElement.appendChild(defs);
  overlayContainer.appendChild(svgElement);
  // Insert overlay into board's parent with relative positioning
    if (boardParent) {
    // Ensure parent has relative positioning
    const parentStyle = window.getComputedStyle(boardParent);
    if (parentStyle.position === "static") {
      boardParent.style.position = "relative";
    }
    boardParent.appendChild(overlayContainer);
  } else {
    // Fallback: append directly to board
    board.style.position = "relative";
    board.appendChild(overlayContainer);
  }
  // Observe board element for size changes (more reliable than window resize alone)
    if (boardResizeObserver) {
    boardResizeObserver.disconnect();
  }
  boardResizeObserver = new ResizeObserver(() => {
    handleResize();
  });
  boardResizeObserver.observe(board);
  // Re-create toggles on the fresh container using last known states
    createAutoplayToggle(isAutoplayEnabled);
  createAntidetectToggle(isAntidetectEnabled);
  return svgElement;
}

/**
 * Calculate arrow path with offset to not obscure pieces
 * @param {Object} from - Starting coordinates {x, y}
 * @param {Object} to - Ending coordinates {x, y}
 * @param {number} squareSize - Size of each square
 * @returns {Object} Adjusted coordinates {fromX, fromY, toX, toY}
 */ function calculateArrowPath(from, to, squareSize) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  // Normalize direction
    const nx = dx / length;
  const ny = dy / length;
  // Offset from center of squares (about 30% of square size)
    const startOffset = squareSize * .3;
  const endOffset = squareSize * .35;
 // Slightly more to account for arrowhead
    return {
    fromX: from.x + nx * startOffset,
    fromY: from.y + ny * startOffset,
    toX: to.x - nx * endOffset,
    toY: to.y - ny * endOffset
  };
}

/**
 * Draw an arrow on the SVG overlay
 * @param {string} fromSquare - Starting square in algebraic notation
 * @param {string} toSquare - Ending square in algebraic notation
 */ function drawArrow(fromSquare, toSquare) {
  const boardInfo = getBoardInfo();
  if (!boardInfo) {
    return;
  }
  const fromCoords = algebraicToCoords(fromSquare);
  const toCoords = algebraicToCoords(toSquare);
  if (!fromCoords || !toCoords) {
    return;
  }
  // Ensure overlay exists
    if (!svgElement || !document.contains(svgElement)) {
    createOverlayContainer(boardInfo.element);
    // Update viewBox after creation
        const rect = boardInfo.rect;
    svgElement.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  }
  // Clear previous arrow and highlights
    clearArrow();
  // Draw square highlights first (so arrow renders on top)
    drawHighlights(fromSquare, toSquare);
  // Calculate pixel positions
    const fromPixels = coordsToPixels(fromCoords.file, fromCoords.rank, boardInfo);
  const toPixels = coordsToPixels(toCoords.file, toCoords.rank, boardInfo);
  // Calculate adjusted path
    const path = calculateArrowPath(fromPixels, toPixels, boardInfo.squareSize);
  // Simple static white dashed line with wider spacing
    const dashLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  dashLine.setAttribute("x1", path.fromX);
  dashLine.setAttribute("y1", path.fromY);
  dashLine.setAttribute("x2", path.toX);
  dashLine.setAttribute("y2", path.toY);
  dashLine.setAttribute("stroke", isWeakMoveDisplay ? ARROW_COLOR_WEAK : "rgba(255, 255, 255, 0.9)");
  dashLine.setAttribute("stroke-width", "8");
  dashLine.setAttribute("stroke-linecap", "round");
  dashLine.setAttribute("stroke-dasharray", "8,16");
  dashLine.classList.add("_xar");
  svgElement.appendChild(dashLine);
  currentArrow = dashLine;
}

/**
 * Clear the current arrow and highlights from the overlay
 */ function clearArrow() {
  if (currentArrow && currentArrow.parentNode) {
    currentArrow.parentNode.removeChild(currentArrow);
    currentArrow = null;
  }
  // Also clear any arrows by class (including rook arrows for castling)
    if (svgElement) {
    const arrows = svgElement.querySelectorAll("._xar");
    arrows.forEach(arrow => arrow.remove());
  }
  // Clear highlights as well
    clearHighlights();
  // Clear promotion indicator
    clearPromotionIndicator();
}

/**
 * Remove the entire overlay from the DOM
 */ function removeOverlay() {
  if (boardResizeObserver) {
    boardResizeObserver.disconnect();
    boardResizeObserver = null;
  }
  if (overlayContainer && overlayContainer.parentNode) {
    overlayContainer.parentNode.removeChild(overlayContainer);
  }
  overlayContainer = null;
  svgElement = null;
  evalDisplayElement = null;
  currentArrow = null;
  currentHighlights = [];
  currentEvaluation = null;
  promotionIndicator = null;
  gameOverElement = null;
  if (statusPillTimeout) {
    clearTimeout(statusPillTimeout);
    statusPillTimeout = null;
  }
  statusPill = null;
  statusPillState = null;
  autoplayToggle = null;
  antidetectToggle = null;
}

/**
 * Show the best move arrow
 * @param {string} bestMove - UCI format move (e.g., 'e2e4')
 * @param {string} fen - Optional FEN to determine piece color for promotion
 */ function showBestMove(bestMove, fen) {
  if (!isOverlayVisible) {
    return;
  }
  const move = parseUciMove(bestMove);
  if (!move) {
    return;
  }
  // Draw the main arrow
    drawArrow(move.from.square, move.to.square);
  // Check for castling and draw rook arrow if applicable
    const castlingInfo = detectCastling(move);
  if (castlingInfo) {
    const boardInfo = getBoardInfo();
    if (boardInfo) {
      drawCastlingRookArrow(castlingInfo, boardInfo);
    }
  }
  // Handle promotion indicator
    if (move.promotion) {
    // Determine if it's white or black promoting based on destination rank
    // White promotes on rank 8, black promotes on rank 1
    const isWhite = move.to.rank === 8;
    drawPromotionIndicator(move.to.square, move.promotion, isWhite);
  } else {
    clearPromotionIndicator();
  }
}

/**
 * Handle waiting state from content.js (opponent's turn)
 * @param {CustomEvent} event - Custom event with waiting details
 */ function handleWaiting(event) {
  _log("[Chess Overlay] ⏳ Waiting for opponent...", event.detail);
  showStatusPill("waiting");
}

/**
 * Handle analysis result from content.js
 * @param {CustomEvent} event - Custom event with analysis details
 */ function handleAnalysisResult(event) {
  _log("[Chess Overlay] 📥 Received analysis event:", event.detail);
  const {bestMove: bestMove, evaluation: evaluation, fen: fen, isWeakMove: isWeakMove} = event.detail;
  isWeakMoveDisplay = !!isWeakMove;
  // Clear status pill when we receive analysis
    clearStatusPill();
  // CONSOLE LOG FOR BEST MOVE (as requested)
    if (bestMove) {
    _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    _log("🎯 NEXT MOVE TO PLAY:", bestMove);
    _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
  // Clear any game over display when we receive a new analysis
    clearGameOver();
  if (bestMove) {
    _log("[Chess Overlay] Drawing arrow for move:", bestMove);
    showBestMove(bestMove, fen);
  }
  // Update evaluation display (even if no best move, show the score)
    if (evaluation) {
    _log("[Chess Overlay] Updating evaluation:", evaluation);
    updateEvalDisplay(evaluation);
  }
}

/**
 * Handle game over event from content.js
 * @param {CustomEvent} event - Custom event with game over details
 */ function handleGameOver(event) {
  const {reason: reason, winner: winner} = event.detail;
  // Clear arrows and evaluation
    clearArrow();
  clearEvalDisplay();
  // Show game over message
    showGameOver(reason, winner);
}

/**
 * Handle clear overlay request
 */ function handleClearOverlay() {
  clearArrow();
  clearEvalDisplay();
  clearPromotionIndicator();
  clearGameOver();
  clearStatusPill();
}

/**
 * Handle targeted clear of analysis only (arrows + eval).
 * Preserves toggles, waiting indicator, and overlay container.
 * Used during position stability checks to avoid flashing.
 */ function handleClearAnalysis() {
  clearArrow();
  clearEvalDisplay();
}

/**
 * Handle error from engine
 * @param {CustomEvent} event - Custom event with error details
 */ function handleError(event) {
  clearArrow();
  clearEvalDisplay();
  const detail = event.detail || {};
  if (detail.canRetry !== false) {
    showStatusPill("error", {
      error: detail.error
    });
  } else {
    clearStatusPill();
  }
}

/**
 * Handle settings change
 * @param {CustomEvent} event - Custom event with settings
 */ function handleSettingsChange(event) {
  const settings = event.detail;
  // If extension is disabled, tear down everything and bail
    if (settings.extensionEnabled === false) {
    removeOverlay();
    return;
  }
  if (settings.analysisEnabled !== undefined) {
    isOverlayVisible = settings.analysisEnabled;
    if (!isOverlayVisible) {
      clearArrow();
      clearEvalDisplay();
    }
  }
  // Update autoplay toggle state
    if (settings.autoplayEnabled !== undefined) {
    createAutoplayToggle(settings.autoplayEnabled);
  }
  // Update antidetect toggle state
    if (settings.antidetectEnabled !== undefined) {
    createAntidetectToggle(settings.antidetectEnabled);
  }
}

/**
 * Handle window resize to update overlay dimensions
 */ function handleResize() {
  if (!svgElement || !overlayContainer) {
    return;
  }
  const boardInfo = getBoardInfo();
  if (!boardInfo) {
    return;
  }
  const boardRect = boardInfo.rect;
  // Update SVG viewBox to match new board dimensions
    svgElement.setAttribute("viewBox", `0 0 ${boardRect.width} ${boardRect.height}`);
  // Update overlay container position and size to track the board
    const platform = window._chPlatform || "chess.com";
  let boardParent;
  if (platform === "lichess") {
    boardParent = boardInfo.element.closest(".cg-wrap") || boardInfo.element.parentElement;
  } else {
    boardParent = boardInfo.element.parentElement;
  }
  if (boardParent) {
    const parentRect = boardParent.getBoundingClientRect();
    const offsetLeft = boardRect.left - parentRect.left;
    const offsetTop = boardRect.top - parentRect.top;
    overlayContainer.style.top = `${offsetTop}px`;
    overlayContainer.style.left = `${offsetLeft}px`;
    overlayContainer.style.width = `${boardRect.width}px`;
    overlayContainer.style.height = `${boardRect.height}px`;
  }
}

// ============================================================
// Rate Limit Overlays (Signup / Upgrade)
// ============================================================
/**
 * Inject hover styles for overlay buttons (once)
 */ function ensureOverlayHoverStyles() {
  if (document.getElementById("chess-helper-overlay-styles")) return;
  const style = document.createElement("style");
  style.id = "chess-helper-overlay-styles";
  style.textContent = `\n    /* Signup button */\n    .chess-helper-btn-signup:hover {\n      background: #15803d !important;\n      transform: translateY(-1px);\n      box-shadow: 0 4px 12px rgba(22, 163, 74, 0.4);\n    }\n    .chess-helper-btn-signup:active {\n      transform: translateY(0);\n      box-shadow: none;\n    }\n    /* Login link */\n    .chess-helper-btn-login:hover {\n      color: #86efac !important;\n    }\n    /* Yearly checkout */\n    .chess-helper-checkout-yearly:hover {\n      transform: translateY(-1px);\n      box-shadow: 0 4px 16px rgba(34, 197, 94, 0.4);\n      filter: brightness(1.1);\n    }\n    .chess-helper-checkout-yearly:active {\n      transform: translateY(0);\n      box-shadow: none;\n      filter: brightness(1);\n    }\n    /* Monthly checkout */\n    .chess-helper-checkout-monthly:hover {\n      background: rgba(255, 255, 255, 0.05) !important;\n      border-color: #9ca3af !important;\n      transform: translateY(-1px);\n    }\n    .chess-helper-checkout-monthly:active {\n      transform: translateY(0);\n    }\n    /* Dismiss / disable */\n    .chess-helper-overlay-dismiss:hover {\n      color: #d1d5db !important;\n    }\n    .chess-helper-overlay-disable:hover {\n      color: #9ca3af !important;\n      opacity: 1 !important;\n    }\n    /* Close X button */\n    .chess-helper-overlay-close:hover {\n      color: #d1d5db !important;\n      background: rgba(255, 255, 255, 0.1) !important;\n    }\n  `;
  document.head.appendChild(style);
}

/**
 * Remove any existing rate limit overlay
 */ function removeRateLimitOverlay() {
  const existing = document.getElementById("chess-helper-overlay");
  if (existing) existing.remove();
}

/**
 * Show the signup overlay for anonymous users who hit the 3-game limit
 * @param {Object} rateLimitData - Rate limit response from the server
 */ function showSignupOverlay(rateLimitData) {
  removeRateLimitOverlay();
  ensureOverlayHoverStyles();
  const appUrl = globalThis._cfg?.APP_URL || "https://chesshelper.ai";
  // Ensure signupUrl is absolute (server may send relative path like "/register")
    let signupUrl = rateLimitData.signupUrl || "/register";
  if (signupUrl.startsWith("/")) {
    signupUrl = `${appUrl}${signupUrl}`;
  }
  // Append callbackUrl so user flows through to /extension/connect after auth
    const callbackParam = "callbackUrl=%2Fextension%2Fconnect";
  signupUrl += (signupUrl.includes("?") ? "&" : "?") + callbackParam;
  const loginUrl = signupUrl.replace("/register", "/login");
  const logoUrl = chrome.runtime.getURL("chess-helper-logo-transparent.png");
  const overlay = document.createElement("div");
  overlay.id = "chess-helper-overlay";
  overlay.innerHTML = `\n    <div style="\n      position: fixed;\n      top: 0; left: 0; right: 0; bottom: 0;\n      background: rgba(0, 0, 0, 0.85);\n      z-index: 999999;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    ">\n      <div style="\n        background: #1a1a2e;\n        border: 1px solid #2d2d44;\n        border-radius: 16px;\n        padding: 40px;\n        max-width: 420px;\n        width: 90%;\n        text-align: center;\n        position: relative;\n      ">\n        <button class="chess-helper-overlay-close" style="\n          position: absolute;\n          top: 12px;\n          right: 12px;\n          background: none;\n          border: none;\n          color: #4b5563;\n          font-size: 20px;\n          line-height: 1;\n          cursor: pointer;\n          padding: 4px 8px;\n          border-radius: 4px;\n          transition: color 0.2s ease, background 0.2s ease;\n        ">&times;</button>\n        <img src="${logoUrl}" alt="ChessHelper.ai" style="width: 64px; height: 64px; margin-bottom: 16px;" />\n        <h2 style="color: #fff; font-size: 22px; margin-bottom: 8px;">\n          You've used all 3 free games\n        </h2>\n        <p style="color: #9ca3af; font-size: 14px; margin-bottom: 24px;">\n          Sign up for a free account to get:\n        </p>\n        <ul style="color: #d1d5db; font-size: 14px; text-align: left; margin: 0 auto 24px; max-width: 250px; list-style: none; padding: 0;">\n          <li style="margin-bottom: 8px;">&#10003; 3 games per day</li>\n          <li style="margin-bottom: 8px;">&#10003; 10 games per week</li>\n          <li style="margin-bottom: 8px;">&#10003; Real-time analysis</li>\n        </ul>\n        <a href="${signupUrl}" rel="noopener" class="chess-helper-btn-signup" style="\n          display: block;\n          background: #16a34a;\n          color: #fff;\n          padding: 14px 24px;\n          border-radius: 10px;\n          font-size: 16px;\n          font-weight: 600;\n          text-decoration: none;\n          margin-bottom: 12px;\n          cursor: pointer;\n          transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;\n        ">\n          Sign Up Free &rarr;\n        </a>\n        <p style="color: #9ca3af; font-size: 13px; margin-bottom: 16px;">\n          Already have an account?\n          <a href="${loginUrl}" rel="noopener" class="chess-helper-btn-login" style="color: #4ade80; text-decoration: underline; cursor: pointer; transition: color 0.2s ease;">\n            Sign in\n          </a>\n        </p>\n        <button class="chess-helper-overlay-dismiss" style="\n          background: none;\n          border: none;\n          color: #6b7280;\n          font-size: 13px;\n          cursor: pointer;\n          padding: 8px;\n          transition: color 0.2s ease;\n        ">\n          Maybe later\n        </button>\n        <button class="chess-helper-overlay-disable" style="\n          display: block;\n          background: none;\n          border: none;\n          color: #6b7280;\n          font-size: 12px;\n          cursor: pointer;\n          padding: 4px 8px;\n          margin: 8px auto 0;\n          opacity: 0.7;\n          transition: color 0.2s ease, opacity 0.2s ease;\n        ">\n          Turn off extension\n        </button>\n      </div>\n    </div>\n  `;
  document.body.appendChild(overlay);
  // Intercept signup/login link clicks to track game tab before opening
    overlay.querySelectorAll("a[href]").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      chrome.runtime.sendMessage({
        type: "OPEN_AUTH_TAB",
        url: link.href
      });
    });
  });
  overlay.querySelector(".chess-helper-overlay-close").addEventListener("click", removeRateLimitOverlay);
  overlay.querySelector(".chess-helper-overlay-dismiss").addEventListener("click", removeRateLimitOverlay);
  overlay.querySelector(".chess-helper-overlay-disable").addEventListener("click", () => {
    chrome.storage.local.set({
      extensionEnabled: false
    });
    removeRateLimitOverlay();
  });
}

/**
 * Show the upgrade overlay for free-tier users who hit their limit
 * @param {Object} rateLimitData - Rate limit response from the server
 */ function showUpgradeOverlay(rateLimitData) {
  removeRateLimitOverlay();
  ensureOverlayHoverStyles();
  const appUrl = globalThis._cfg?.APP_URL || "https://chesshelper.ai";
  // Ensure upgradeUrl is absolute (server may send relative path like "/pricing")
    let upgradeUrl = rateLimitData.upgradeUrl || "/pricing";
  if (upgradeUrl.startsWith("/")) {
    upgradeUrl = `${appUrl}${upgradeUrl}`;
  }
  const limits = rateLimitData.limits;
  const dailyExhausted = limits?.daily?.remaining === 0;
  const weeklyExhausted = limits?.weekly?.remaining === 0;
  let limitMessage = "Game limit reached";
  let resetMessage = "";
  if (dailyExhausted) {
    limitMessage = `Daily limit reached (${limits.daily.used}/${limits.daily.limit})`;
    resetMessage = "Resets at midnight UTC";
  } else if (weeklyExhausted) {
    limitMessage = `Weekly limit reached (${limits.weekly.used}/${limits.weekly.limit})`;
    resetMessage = "Resets Monday at midnight UTC";
  }
  const logoUrl = chrome.runtime.getURL("chess-helper-logo-transparent.png");
  const overlay = document.createElement("div");
  overlay.id = "chess-helper-overlay";
  overlay.innerHTML = `\n    <div style="\n      position: fixed;\n      top: 0; left: 0; right: 0; bottom: 0;\n      background: rgba(0, 0, 0, 0.85);\n      z-index: 999999;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n    ">\n      <div style="\n        background: #1a1a2e;\n        border: 1px solid #2d2d44;\n        border-radius: 16px;\n        padding: 40px;\n        max-width: 420px;\n        width: 90%;\n        text-align: center;\n        position: relative;\n      ">\n        <button class="chess-helper-overlay-close" style="\n          position: absolute;\n          top: 12px;\n          right: 12px;\n          background: none;\n          border: none;\n          color: #4b5563;\n          font-size: 20px;\n          line-height: 1;\n          cursor: pointer;\n          padding: 4px 8px;\n          border-radius: 4px;\n          transition: color 0.2s ease, background 0.2s ease;\n        ">&times;</button>\n        <img src="${logoUrl}" alt="ChessHelper.ai" style="width: 64px; height: 64px; margin-bottom: 16px;" />\n        <h2 style="color: #fff; font-size: 22px; margin-bottom: 8px;">\n          ${limitMessage}\n        </h2>\n        <p style="color: #9ca3af; font-size: 14px; margin-bottom: 24px;">\n          Upgrade to Pro for:\n        </p>\n        <ul style="color: #d1d5db; font-size: 14px; text-align: left; margin: 0 auto 24px; max-width: 250px; list-style: none; padding: 0;">\n          <li style="margin-bottom: 8px;">&#10003; Unlimited games</li>\n          <li style="margin-bottom: 8px;">&#10003; No daily or weekly limits</li>\n          <li style="margin-bottom: 8px;">&#10003; Priority analysis</li>\n        </ul>\n        <button class="chess-helper-checkout-yearly" style="\n          display: block;\n          width: 100%;\n          background: linear-gradient(135deg, #16a34a, #15803d);\n          color: #fff;\n          padding: 14px 24px;\n          border-radius: 10px;\n          font-size: 16px;\n          font-weight: 600;\n          cursor: pointer;\n          margin-bottom: 8px;\n          border: 2px solid #22c55e;\n          position: relative;\n          transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.2s ease;\n        ">\n          <span style="position: absolute; top: -10px; right: -10px; background: #eab308; color: #000; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px;">Best Value</span>\n          Yearly &mdash; $39.99 first year &rarr;\n          <span style="display: block; font-size: 12px; font-weight: 400; opacity: 0.85; margin-top: 2px;">\n            <s>$99.99</s> &middot; Save 60%\n          </span>\n        </button>\n        <button class="chess-helper-checkout-monthly" style="\n          display: block;\n          width: 100%;\n          background: transparent;\n          color: #fff;\n          padding: 12px 24px;\n          border-radius: 10px;\n          font-size: 14px;\n          font-weight: 600;\n          cursor: pointer;\n          margin-bottom: 12px;\n          border: 1px solid #4b5563;\n          transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease;\n        ">\n          Monthly &mdash; $2.99 first month\n          <span style="display: block; font-size: 12px; font-weight: 400; opacity: 0.7; margin-top: 2px;">Then $9.99/mo</span>\n        </button>\n        ${resetMessage ? `<p style="color: #9ca3af; font-size: 13px; margin-bottom: 16px;">${resetMessage}</p>` : ""}\n        <button class="chess-helper-overlay-dismiss" style="\n          background: none;\n          border: none;\n          color: #6b7280;\n          font-size: 13px;\n          cursor: pointer;\n          padding: 8px;\n          transition: color 0.2s ease;\n        ">\n          Maybe later\n        </button>\n        <button class="chess-helper-overlay-disable" style="\n          display: block;\n          background: none;\n          border: none;\n          color: #6b7280;\n          font-size: 12px;\n          cursor: pointer;\n          padding: 4px 8px;\n          margin: 8px auto 0;\n          opacity: 0.7;\n          transition: color 0.2s ease, opacity 0.2s ease;\n        ">\n          Turn off extension\n        </button>\n      </div>\n    </div>\n  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".chess-helper-overlay-close").addEventListener("click", removeRateLimitOverlay);
  overlay.querySelector(".chess-helper-overlay-dismiss").addEventListener("click", removeRateLimitOverlay);
  overlay.querySelector(".chess-helper-overlay-disable").addEventListener("click", () => {
    chrome.storage.local.set({
      extensionEnabled: false
    });
    removeRateLimitOverlay();
  });
  // Checkout button handlers — dispatch events to content.js which relays to service worker
    const checkoutAppUrl = globalThis._cfg?.APP_URL || "https://chesshelper.ai";
  function handleCheckoutClick(priceId, btn) {
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = "0.6";
    btn.innerHTML = "Opening checkout...";
    // Listen for result from content.js
        function onResult(e) {
      window.removeEventListener("_xcheckout_result", onResult);
      if (e.detail.success) {
        removeRateLimitOverlay();
      } else {
        // Restore button and fall back to pricing page
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.innerHTML = originalHTML;
        window.open(`${checkoutAppUrl}/pricing`, "_blank");
      }
    }
    window.addEventListener("_xcheckout_result", onResult);
    window.dispatchEvent(new CustomEvent("_xcheckout", {
      detail: {
        priceId: priceId
      }
    }));
  }
  overlay.querySelector(".chess-helper-checkout-yearly").addEventListener("click", function() {
    handleCheckoutClick("pro-yearly", this);
  });
  overlay.querySelector(".chess-helper-checkout-monthly").addEventListener("click", function() {
    handleCheckoutClick("pro-monthly", this);
  });
}

/**
 * Handle rate limit event from content.js
 * @param {CustomEvent} event - Custom event with rate limit data
 */ function handleRateLimit(event) {
  const rateLimitData = event.detail;
  // Skip rate limit overlay if disabled via config
    if (globalThis._cfg?.RATE_LIMIT_OVERLAY === false) {
    _log("[Chess Overlay] Rate limit overlay disabled via config");
    return;
  }
  // Clear analysis overlay
    clearArrow();
  clearEvalDisplay();
  clearStatusPill();
  if (!rateLimitData.authenticated) {
    // Anonymous user hit limit
    showSignupOverlay(rateLimitData);
  } else if (rateLimitData.tier === "free") {
    // Free user hit limit
    showUpgradeOverlay(rateLimitData);
  }
}

/**
 * Initialize the overlay system
 */ function initOverlay() {
  _log("[Chess Overlay] Initializing overlay system...");
  // Listen for analysis results from content.js
    window.addEventListener("_xa", handleAnalysisResult);
  window.addEventListener("_xc", handleClearOverlay);
  window.addEventListener("_xca", handleClearAnalysis);
  window.addEventListener("_xw", handleWaiting);
  window.addEventListener("_xe", handleError);
  window.addEventListener("_xs", handleSettingsChange);
  window.addEventListener("_xg", handleGameOver);
  window.addEventListener("_xrl", handleRateLimit);
  // Handle analyzing state from content.js (API request in-flight)
    window.addEventListener("_xz", () => showStatusPill("analyzing"));
  // Handle new game — fully tear down overlay for fresh recreation
    window.addEventListener("_xng", () => {
    _log("[Chess Overlay] 🔄 New game detected — removing overlay for fresh start");
    removeOverlay();
  });
  // Handle window resize
    window.addEventListener("resize", handleResize);
  // Listen for extension being disabled
    chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.extensionEnabled?.newValue === false) {
      removeOverlay();
      removeRateLimitOverlay();
    }
  });
  // Clean up on page unload
    window.addEventListener("beforeunload", () => {
    removeOverlay();
    removeRateLimitOverlay();
  });
  _log("[Chess Overlay] Overlay initialization complete");
}

// Initialize when script loads
initOverlay();