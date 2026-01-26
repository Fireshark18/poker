/* global io */
const socket = io();

let currentCode = null;
let lastState = null;

const $ = (id) => document.getElementById(id);

function prettyCard(card) {
  if (!card || card === "??") return "??";
  const r = card[0];
  const s = card[1];
  const suit = s === "s" ? "♠" : s === "h" ? "♥" : s === "d" ? "♦" : "♣";
  return r + suit;
}

function cardEl(card) {
  const d = document.createElement("div");
  d.className = "cardFace";
  d.textContent = prettyCard(card);
  return d;
}

function setScreen(screen) {
  $("screen-join").classList.toggle("hidden", screen !== "join");
  $("screen-room").classList.toggle("hidden", screen !== "room");
}

function getMe(state) {
  return state?.players?.find(p => p.id === state.you.id) || null;
}

function render(state) {
  lastState = state;
  currentCode = state.code;

  $("roomCodeLabel").textContent = state.code;
  $("stageLabel").textContent = state.state === "lobby" ? "Lobby" : (state.stage || "—");
  $("potLabel").textContent = String(state.pot ?? 0);

  // Host controls
  const isHost = state.you.id === state.hostId;
  $("hostControls").classList.toggle("hidden", !isHost);

  // Update blinds inputs from server
  $("sbInput").value = state.smallBlind;
  $("bbInput").value = state.bigBlind;

  // Community
  $("communityCards").innerHTML = "";
  for (const c of (state.community || [])) $("communityCards").appendChild(cardEl(c));

  // Players
  const me = getMe(state);
  const mySeat = me?.seat;
  $("players").innerHTML = "";

  for (const p of state.players) {
    const row = document.createElement("div");
    row.className = "playerRow";
    if (p.id === state.you.id) row.classList.add("me");
    if (state.state === "hand" && p.seat === state.currentSeat) row.classList.add("turn");
    if (p.folded) row.classList.add("folded");

    const left = document.createElement("div");
    left.className = "playerLeft";

    const name = document.createElement("div");
    name.className = "playerName";
    name.textContent = `${p.name} (seat ${p.seat})`;

    const meta = document.createElement("div");
    meta.className = "playerMeta";
    const betPart = p.betThisRound ? ` · bet ${p.betThisRound}` : "";
    const connPart = p.connected ? "" : " · disconnected";
    meta.textContent = `stack ${p.stack}${betPart}${connPart}`;

    left.appendChild(name);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "6px";
    right.style.alignItems = "center";

    if (p.seat === state.dealerSeat) {
      const b = document.createElement("span");
      b.className = "badge dealer";
      b.textContent = "D";
      right.appendChild(b);
    }
    if (p.allIn) {
      const b = document.createElement("span");
      b.className = "badge allin";
      b.textContent = "ALL-IN";
      right.appendChild(b);
    }
    if (p.folded) {
      const b = document.createElement("span");
      b.className = "badge folded";
      b.textContent = "FOLD";
      right.appendChild(b);
    }

    // Show small hole preview (?? ?? for others until showdown)
    if ((p.hole || []).length) {
      const mini = document.createElement("span");
      mini.className = "badge";
      mini.textContent = p.hole.map(prettyCard).join(" ");
      right.appendChild(mini);
    }

    row.appendChild(left);
    row.appendChild(right);
    $("players").appendChild(row);
  }

  // Your hand
  $("yourCards").innerHTML = "";
  if (me && (me.hole || []).length) {
    for (const c of me.hole) $("yourCards").appendChild(cardEl(c));
  } else {
    $("yourCards").appendChild(cardEl("??"));
    $("yourCards").appendChild(cardEl("??"));
  }

  // Actions
  const isHand = state.state === "hand";
  const isYourTurn = isHand && me && state.currentSeat === me.seat && !me.folded && !me.allIn;

  const callAmt = (me && isHand) ? Math.max(0, (state.currentBet || 0) - (me.betThisRound || 0)) : 0;
  $("callLabel").textContent = String(callAmt);

  $("btnFold").disabled = !isYourTurn;
  $("btnRaise").disabled = !isYourTurn;

  // Check/Call label
  if (!isYourTurn) {
    $("btnCheckCall").disabled = true;
    $("btnCheckCall").textContent = "Check/Call";
    $("turnHint").textContent = isHand ? "Waiting for other players…" : "Waiting in the lobby…";
  } else {
    $("btnCheckCall").disabled = false;
    $("btnCheckCall").textContent = callAmt === 0 ? "Check" : `Call ${callAmt}`;
    $("turnHint").textContent = "Your turn!";
  }

  // Bet/Raise helper text
  const placeholder = (state.currentBet || 0) === 0 ? "Bet to…" : "Raise to…";
  $("raiseAmount").placeholder = placeholder;

  // Log
  const logText = (state.log || []).join("\n");
  const logEl = $("log");
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  logEl.textContent = logText;
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- Wire up UI ----
$("btnCreate").addEventListener("click", () => {
  const name = $("hostName").value.trim() || "Host";
  socket.emit("createLobby", { name });
});

$("btnJoin").addEventListener("click", () => {
  $("joinError").textContent = "";
  const name = $("joinName").value.trim() || "Player";
  const code = $("roomCode").value.trim().toUpperCase();
  socket.emit("joinLobby", { name, code });
});

$("btnSetBlinds").addEventListener("click", () => {
  if (!currentCode) return;
  socket.emit("setBlinds", {
    code: currentCode,
    smallBlind: Number($("sbInput").value),
    bigBlind: Number($("bbInput").value),
  });
});

$("btnStart").addEventListener("click", () => {
  if (!currentCode) return;
  socket.emit("startGame", { code: currentCode });
});

$("btnFold").addEventListener("click", () => {
  if (!currentCode) return;
  socket.emit("playerAction", { code: currentCode, action: "fold" });
});

$("btnCheckCall").addEventListener("click", () => {
  if (!currentCode) return;
  // Server handles check vs call.
  socket.emit("playerAction", { code: currentCode, action: "call" });
});

$("btnRaise").addEventListener("click", () => {
  if (!currentCode) return;
  const amt = Number($("raiseAmount").value);
  if (!amt || amt <= 0) return;
  // Server will interpret as bet if currentBet is 0, otherwise raise.
  const action = (lastState?.currentBet || 0) === 0 ? "bet" : "raise";
  socket.emit("playerAction", { code: currentCode, action, amount: amt });
  $("raiseAmount").value = "";
});

$("btnChat").addEventListener("click", () => {
  if (!currentCode) return;
  const msg = $("chatInput").value.trim();
  if (!msg) return;
  socket.emit("chat", { code: currentCode, message: msg });
  $("chatInput").value = "";
});

$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnChat").click();
});

// ---- Socket events ----
socket.on("lobbyCreated", ({ code }) => {
  currentCode = code;
  setScreen("room");
});

socket.on("joinOk", ({ code }) => {
  currentCode = code;
  setScreen("room");
});

socket.on("joinError", ({ message }) => {
  $("joinError").textContent = message || "Could not join.";
});

socket.on("roomState", (state) => {
  setScreen("room");
  render(state);
});

// Default to join screen
setScreen("join");
