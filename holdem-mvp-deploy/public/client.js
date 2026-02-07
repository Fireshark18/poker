/* global io */
const socket = io();

let currentCode = null;
let lastState = null;
let _revealTimer = null;

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
  // color red for hearts/diamonds
  if (card && card !== "??") {
    const s = card[1];
    if (s === 'h' || s === 'd') d.classList.add('red');
  }
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

  // Players - positioned around the table
  const me = getMe(state);
  const mySeat = me?.seat;
  $("seatsContainer").innerHTML = "";

  const totalSeats = 6; // 6-max table
  const players = state.players;
  
  // Create seat positions (arranged in a circle)
  const seatPositions = {
    0: { top: '5%', left: '50%', transform: 'translateX(-50%)' },      // Top
    1: { top: '15%', left: '82%', transform: 'translate(-50%, 0)' },    // Top right
    2: { top: '50%', left: '90%', transform: 'translate(-50%, -50%)' }, // Right
    3: { bottom: '10%', left: '82%', transform: 'translate(-50%, 0)' }, // Bottom right
    4: { bottom: '5%', left: '50%', transform: 'translateX(-50%)' },    // Bottom
    5: { top: '50%', left: '10%', transform: 'translate(-50%, -50%)' }  // Left
  };

  for (const p of players) {
    const seatPos = seatPositions[p.seat];
    if (!seatPos) continue;

    const seatEl = document.createElement("div");
    seatEl.className = "playerSeat";
    seatEl.style.top = seatPos.top || 'auto';
    seatEl.style.bottom = seatPos.bottom || 'auto';
    seatEl.style.left = seatPos.left;
    seatEl.style.transform = seatPos.transform;

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "playerAvatar";
    if (p.id === state.you.id) avatar.classList.add("me");
    if (state.state === "hand" && p.seat === state.currentSeat) avatar.classList.add("turn");
    if (p.folded) avatar.classList.add("folded");
    if (p.allIn) avatar.classList.add("all-in");
    
    // Use first letter of name as avatar
    avatar.textContent = p.name[0].toUpperCase();
    seatEl.appendChild(avatar);

    // Show hole cards if present (during reveal/showdown or for viewer)
    if (p.hole && p.hole.length) {
      const mini = document.createElement('div');
      mini.className = 'miniHole';
      for (const c of p.hole) {
        const m = cardEl(c);
        m.classList.add('miniCard');
        mini.appendChild(m);
      }
      seatEl.appendChild(mini);
    }
    // Bet amount if exists
    if (p.betThisRound) {
      const betEl = document.createElement("div");
      betEl.className = "playerBet";
      betEl.textContent = `${p.betThisRound}`;
      avatar.appendChild(betEl);
    }

    // Info
    const info = document.createElement("div");
    info.className = "playerInfo";

    const name = document.createElement("div");
    name.className = "playerName";
    name.textContent = p.name;
    info.appendChild(name);

    const stack = document.createElement("div");
    stack.className = "playerStack";
    stack.textContent = `Stack: ${p.stack}${p.connected ? '' : ' [DC]'}`;
    info.appendChild(stack);

    // Show hand rank for spectators
    if (p.handRank && p.handRank.name) {
      const handDiv = document.createElement("div");
      handDiv.className = "playerHandRank";
      handDiv.textContent = p.handRank.name;
      handDiv.style.fontSize = "0.85em";
      handDiv.style.color = "#888";
      info.appendChild(handDiv);
    }

    // Badges
    const badges = document.createElement("div");
    badges.className = "playerBadges";
    
    if (p.seat === state.dealerSeat) {
      const b = document.createElement("span");
      b.className = "badge dealer";
      b.textContent = "D";
      badges.appendChild(b);
    }
    if (p.allIn) {
      const b = document.createElement("span");
      b.className = "badge allin";
      b.textContent = "ALL-IN";
      badges.appendChild(b);
    }
    if (p.folded) {
      const b = document.createElement("span");
      b.className = "badge folded";
      b.textContent = "FOLD";
      badges.appendChild(b);
    }

    if (badges.children.length > 0) {
      info.appendChild(badges);
    }

    seatEl.appendChild(info);
    $("seatsContainer").appendChild(seatEl);
  }

  // Reveal animation: add class to table during reveal state
  const pokerTableEl = document.querySelector('.pokerTable');
  if (pokerTableEl) {
    if (state.state === 'reveal') pokerTableEl.classList.add('revealing');
    else pokerTableEl.classList.remove('revealing');
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
  $("btnAllIn").disabled = !isYourTurn || (me && me.stack <= 0);

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

  // Chat - disable for spectators
  const isSpectator = state.you?.isSpectator;
  $("chatInput").disabled = isSpectator;
  $("btnChat").disabled = isSpectator;
  if (isSpectator) {
    $("chatInput").placeholder = "Spectators cannot chat";
  }

  // Equity info for spectators
  if (isSpectator && state.equityInfo && state.equityInfo.length > 0) {
    const equityEl = document.getElementById("equityInfo");
    if (equityEl) {
      equityEl.innerHTML = "<h4>Remaining Players & Win %</h4>";
      for (const info of state.equityInfo) {
        const div = document.createElement("div");
        div.className = "equityRow";
        div.innerHTML = `<div class="equityName">${info.playerName}</div><div class="equityHand">${info.handName}</div><div class="equityPercent">${info.equity}%</div>`;
        equityEl.appendChild(div);
      }
    }
  } else {
    const equityEl = document.getElementById("equityInfo");
    if (equityEl) equityEl.innerHTML = "";
  }

  // Show winner modal if hand is over and winner info exists
  // If server enters 'reveal', show reveal animations and schedule winner modal locally
  if (state.state === "reveal" && state.winnerInfo) {
    // ensure modal hidden during reveal animation
    $("winnerModal").classList.add("hidden");
    // clear any existing timer
    if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
    // schedule to show winner modal after reveal animation (3s)
    _revealTimer = setTimeout(() => {
      const winner = state.winnerInfo;
      $("winnerName").textContent = winner.playerNames;
      $("winnerAmount").textContent = `+${winner.amount}`;
      $("winnerHand").textContent = winner.hand;
      $("winnerDescription").textContent = winner.description;
      $("winnerModal").classList.remove("hidden");
      _revealTimer = null;
    }, 3000);
  } else if (state.state === "showdown" && state.winnerInfo) {
    // show immediately if server already moved to showdown
    if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
    const winner = state.winnerInfo;
    $("winnerName").textContent = winner.playerNames;
    $("winnerAmount").textContent = `+${winner.amount}`;
    $("winnerHand").textContent = winner.hand;
    $("winnerDescription").textContent = winner.description;
    $("winnerModal").classList.remove("hidden");
  } else {
    if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
    $("winnerModal").classList.add("hidden");
  }
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

$("btnAddBot")?.addEventListener("click", () => {
  if (!currentCode) return;
  socket.emit("addBot", { code: currentCode });
});

$("btnNextHand").addEventListener("click", () => {
  if (!currentCode) return;
  socket.emit("startGame", { code: currentCode });
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

$("btnAllIn").addEventListener("click", () => {
  if (!currentCode) {
    return;
  }
  const me = getMe(lastState);
  if (!me) {
    return;
  }
  if (me.stack <= 0) {
    return;
  }
  const totalChips = me.betThisRound + me.stack;
  socket.emit("playerAction", { code: currentCode, action: "all-in", amount: totalChips });
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
