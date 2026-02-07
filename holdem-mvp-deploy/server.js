const path = require("path");
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Hand } = require("pokersolver");

// ---- Config ----
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const STARTING_STACK = 2000;

// ---- Helpers ----
const SUITS = ["s", "h", "d", "c"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I for clarity

function makeRoomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

function shuffleInPlace(arr) {
  // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return shuffleInPlace(deck);
}

function prettyCard(card) {
  // "As" -> "A♠"
  if (!card || card === "??") return "??";
  const r = card[0];
  const s = card[1];
  const suit = s === "s" ? "♠" : s === "h" ? "♥" : s === "d" ? "♦" : "♣";
  return r + suit;
}

function nextSeat(room, fromSeat) {
  // returns next seat that has a player (even folded), in seat order
  const seats = room.players.map(p => p.seat).sort((a,b)=>a-b);
  if (!seats.length) return null;
  let seat = fromSeat;
  for (let i=0; i<MAX_PLAYERS; i++) {
    seat = (seat + 1) % MAX_PLAYERS;
    if (seats.includes(seat)) return seat;
  }
  return null;
}

function nextActiveSeat(room, fromSeat, opts = {}) {
  // next player who can act (not folded, not all-in, has stack maybe)
  const seats = room.players.map(p => p.seat).sort((a,b)=>a-b);
  if (!seats.length) return null;
  let seat = fromSeat;
  for (let i=0; i<MAX_PLAYERS; i++) {
    seat = (seat + 1) % MAX_PLAYERS;
    const p = room.players.find(x => x.seat === seat);
    if (!p) continue;
    if (opts.includeFolded !== true && p.folded) continue;
    if (opts.includeAllIn !== true && p.allIn) continue;
    if (opts.requireStack && p.stack <= 0) continue;
    return seat;
  }
  return null;
}

function actingPlayers(room) {
  return room.players.filter(p => !p.folded && !p.allIn && p.stack > 0);
}

function livePlayers(room) {
  return room.players.filter(p => !p.folded);
}

function seatedPlayers(room) {
  return [...room.players].sort((a,b)=>a.seat-b.seat);
}

function activeSeats(room) {
  return seatedPlayers(room).filter(p => p.stack > 0).map(p => p.seat);
}

function seatOfPlayer(room, playerId) {
  const p = room.players.find(p => p.id === playerId);
  return p ? p.seat : null;
}

function addLog(room, msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.log.push(line);
  if (room.log.length > 200) room.log.shift();
}

function assignSeat(room) {
  const used = new Set(room.players.map(p => p.seat));
  for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return null;
}

function commitChips(room, player, wanted) {
  const pay = Math.max(0, Math.min(wanted, player.stack));
  player.stack -= pay;
  player.betThisRound += pay;
  player.committed += pay;
  room.pot += pay;
  if (player.stack === 0) player.allIn = true;
  return pay;
}

function resetForNewHand(room) {
  room.state = "hand";
  room.stage = "preflop";
  room.community = [];
  room.deck = freshDeck();
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.lastAggressorSeat = null;
  room.currentSeat = null;
  room.lastActionAt = Date.now();
  room.handOverAt = null;
  room.winnerInfo = null;

  for (const p of room.players) {
    p.folded = p.stack <= 0;
    p.allIn = false;
    p.betThisRound = 0;
    p.committed = 0;
    p.hole = [];
    p.hasActed = false;
    p.lastAction = null;
  }
}

function startBettingRound(room) {
  // for flop/turn/river
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.lastAggressorSeat = null;
  for (const p of room.players) {
    if (!p.folded && !p.allIn) {
      p.betThisRound = 0;
      p.hasActed = false;
    }
  }
  const first = nextActiveSeat(room, room.dealerSeat, { includeAllIn: false, includeFolded: false });
  room.currentSeat = first;
  addLog(room, `Betting starts with seat ${first}.`);
}

function shouldEndBettingRound(room) {
  const ps = room.players.filter(p => !p.folded && !p.allIn);
  if (ps.length === 0) return true; // everyone all-in or folded
  const allMatched = ps.every(p => p.betThisRound === room.currentBet);
  const allActed = ps.every(p => p.hasActed);
  return allMatched && allActed;
}

function countNotFolded(room) {
  return room.players.filter(p => !p.folded).length;
}

function loneSurvivor(room) {
  const ps = room.players.filter(p => !p.folded);
  return ps.length === 1 ? ps[0] : null;
}

function dealHoleCards(room) {
  // deal starting from seat left of dealer (small blind seat in most cases)
  const seats = activeSeats(room);
  if (seats.length < 2) return;

  // Find first to deal to: seat after dealer among active stacks.
  let seat = nextActiveSeat(room, room.dealerSeat, { includeAllIn: true, includeFolded: true, requireStack: true });
  for (let round = 0; round < 2; round++) {
    for (let i=0; i<seats.length; i++) {
      const p = room.players.find(x => x.seat === seat);
      if (p && p.stack >= 0) {
        p.hole.push(room.deck.pop());
      }
      seat = nextActiveSeat(room, seat, { includeAllIn: true, includeFolded: true, requireStack: true });
    }
  }
}

function postBlinds(room) {
  const seats = activeSeats(room);
  if (seats.length < 2) return;

  // Heads-up: dealer is small blind, other is big blind.
  let sbSeat, bbSeat;
  if (seats.length === 2) {
    sbSeat = room.dealerSeat;
    bbSeat = nextActiveSeat(room, sbSeat, { includeAllIn: true, includeFolded: true, requireStack: true });
  } else {
    sbSeat = nextActiveSeat(room, room.dealerSeat, { includeAllIn: true, includeFolded: true, requireStack: true });
    bbSeat = nextActiveSeat(room, sbSeat, { includeAllIn: true, includeFolded: true, requireStack: true });
  }

  const sb = room.players.find(p => p.seat === sbSeat);
  const bb = room.players.find(p => p.seat === bbSeat);

  commitChips(room, sb, room.smallBlind);
  commitChips(room, bb, room.bigBlind);

  room.currentBet = Math.max(sb.betThisRound, bb.betThisRound);
  room.minRaise = room.bigBlind;
  room.lastAggressorSeat = bbSeat;

  // Mark blinds as having acted? In standard poker, blinds haven't acted yet in preflop.
  // We'll treat them as not acted so action comes around correctly.
  for (const p of room.players) {
    if (!p.folded && !p.allIn) p.hasActed = false;
  }

  addLog(room, `Blinds posted: SB seat ${sbSeat} (${room.smallBlind}), BB seat ${bbSeat} (${room.bigBlind}).`);
  return { sbSeat, bbSeat };
}

function firstToActPreflop(room, bbSeat) {
  const seats = activeSeats(room);
  if (seats.length === 2) {
    // Heads-up: SB (dealer) acts first preflop
    return room.dealerSeat;
  }
  return nextActiveSeat(room, bbSeat, { includeAllIn: false, includeFolded: false, requireStack: true });
}

function advanceStage(room) {
  if (room.stage === "preflop") {
    room.stage = "flop";
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    addLog(room, `Flop: ${room.community.map(prettyCard).join(" ")}`);
    startBettingRound(room);
  } else if (room.stage === "flop") {
    room.stage = "turn";
    room.community.push(room.deck.pop());
    addLog(room, `Turn: ${prettyCard(room.community[3])}`);
    startBettingRound(room);
  } else if (room.stage === "turn") {
    room.stage = "river";
    room.community.push(room.deck.pop());
    addLog(room, `River: ${prettyCard(room.community[4])}`);
    startBettingRound(room);
  } else if (room.stage === "river") {
    // Enter reveal state so clients can animate showing hole cards
    room.state = "reveal";
    room.currentSeat = null;
    addLog(room, `Reveal!`);

    // broadcast reveal and schedule showdown resolution
    broadcastRoom(io, room);
    setTimeout(() => {
      const rr = rooms.get(room.code);
      if (!rr) return;
      resolveShowdown(rr);
      rr.state = "showdown";
      rr.currentSeat = null;
      console.log(`Room ${rr.code}: advanceStage -> broadcasting SHOWDOWN with winnerInfo=`, rr.winnerInfo);
      broadcastRoom(io, rr);

      // Auto-start next hand after a pause
      setTimeout(() => {
        const r2 = rooms.get(room.code);
        if (!r2) return;
        r2.state = "lobby";
        r2.stage = "preflop";
        for (const pl of r2.players) {
          pl.folded = pl.stack <= 0;
          pl.allIn = false;
          pl.betThisRound = 0;
          pl.committed = 0;
          pl.hole = [];
          pl.hasActed = false;
          pl.lastAction = null;
        }
        const seats = activeSeats(r2);
        if (seats.length >= 2) {
          r2.state = "hand";
          beginHand(r2);
        } else {
          addLog(r2, "Waiting for at least 2 players with chips to continue.");
        }
        broadcastRoom(io, r2);
      }, 3500);
    }, 3000);
  }
}

function buildSidePots(players) {
  const contrib = players.filter(p => p.committed > 0);
  if (contrib.length === 0) return [];
  const levels = [...new Set(contrib.map(p => p.committed))].sort((a,b)=>a-b);
  let prev = 0;
  const pots = [];
  for (const level of levels) {
    const inThis = contrib.filter(p => p.committed >= level);
    const amount = (level - prev) * inThis.length;
    const eligible = inThis.filter(p => !p.folded).map(p => p.id);
    pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function calculateHandEquity(room) {
  // Calculate equity for remaining (non-folded) players
  // Returns array of { playerId, playerName, hand, handName, equity }
  const remainingPlayers = room.players.filter(p => !p.folded);
  if (remainingPlayers.length < 2) return [];

  const board = room.community;
  const remainingCards = getAllRemainingCards(board, remainingPlayers);
  
  // Evaluate current best hand for each player
  const results = [];
  for (const p of remainingPlayers) {
    const cards = [...board, ...p.hole];
    const solved = Hand.solve(cards, "standard");
    results.push({
      playerId: p.id,
      playerName: p.name,
      hand: solved,
      handName: solved.name,
      handDescr: solved.descr,
      equity: 0 // will be calculated below
    });
  }

  // Simple equity calculation: simulate all possible remaining cards
  if (remainingCards.length === 0 || remainingCards.length > 5) {
    // Already at showdown or too early; just rank by current hand strength
    // Sort hands using Hand.winners() for proper poker hand ranking
    let remaining = [...results];
    let equityPoints = [];
    
    while (remaining.length > 0) {
      const hands = remaining.map(r => r.hand);
      const winners = Hand.winners(hands);
      const winnersSet = new Set(winners);
      
      const ranking = winners.length > 0 ? winners.length : 1;
      for (const r of remaining) {
        if (winnersSet.has(r.hand)) {
          equityPoints.push({ playerId: r.playerId, points: remaining.length });
        }
      }
      
      remaining = remaining.filter(r => !winnersSet.has(r.hand));
    }
    
    // Assign equity based on points
    const totalPoints = equityPoints.reduce((sum, ep) => sum + ep.points, 0);
    for (const result of results) {
      const ep = equityPoints.find(e => e.playerId === result.playerId);
      result.equity = ep ? Math.round(ep.points * 100 / totalPoints) : 0;
    }
  } else {
    // Do a quick Monte Carlo with remaining cards
    const trials = Math.min(5000, 2 ** remainingCards.length); // limit trials
    const wins = new Map(results.map(r => [r.playerId, 0]));
    
    for (let trial = 0; trial < trials; trial++) {
      const shuffled = [...remainingCards];
      shuffleInPlace(shuffled);
      const boardCopy = [...board, ...shuffled.slice(0, 5 - board.length)];
      
      const hands = results.map(r => ({
        playerId: r.playerId,
        hand: Hand.solve([...boardCopy, ...room.players.find(p => p.id === r.playerId).hole], "standard")
      }));
      
      const winningHands = Hand.winners(hands.map(h => h.hand));
      for (const hand of winningHands) {
        const pid = hands.find(h => h.hand === hand)?.playerId;
        if (pid) wins.set(pid, (wins.get(pid) || 0) + 1);
      }
    }
    
    for (const r of results) {
      r.equity = Math.round((wins.get(r.playerId) || 0) * 100 / trials);
    }
  }

  return results;
}

function getAllRemainingCards(board, players) {
  const used = new Set([...board, ...players.flatMap(p => p.hole)]);
  const all = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      const card = r + s;
      if (!used.has(card)) all.push(card);
    }
  }
  return all;
}

function getHandRank(community, hole) {
  // Helper to get hand rank name and description for a given hole cards
  if (!community || !hole || hole.length !== 2) return null;
  const cards = [...community, ...hole];
  const solved = Hand.solve(cards, "standard");
  return {
    name: solved.name,
    descr: solved.descr
  };
}

function resolveShowdown(room) {
  const pots = buildSidePots(room.players);
  const board = room.community;

  // Evaluate hands for all players still live
  const solvedById = new Map();
  for (const p of room.players) {
    if (p.folded) continue;
    const cards = [...board, ...p.hole];
    const solved = Hand.solve(cards, "standard");
    solvedById.set(p.id, solved);
  }

  // For each pot, determine winners among eligible.
  const payouts = new Map(); // playerId -> chips won
  const notes = [];
  const winners = []; // Track main winner info for UI

  for (const pot of pots) {
    const elig = pot.eligible.filter(id => solvedById.has(id));
    if (elig.length === 0) continue;

    const entries = elig.map(id => ({ id, hand: solvedById.get(id) }));
    const winnersHands = Hand.winners(entries.map(e => e.hand));
    const potWinners = entries.filter(e => winnersHands.includes(e.hand)).map(e => e.id);

    const share = Math.floor(pot.amount / potWinners.length);
    let remainder = pot.amount - share * potWinners.length;

    for (const wid of potWinners) {
      payouts.set(wid, (payouts.get(wid) || 0) + share);
    }
    if (remainder > 0) {
      // Give odd chip(s) to first winner (simple rule for MVP).
      payouts.set(potWinners[0], (payouts.get(potWinners[0]) || 0) + remainder);
      remainder = 0;
    }

    const prettyWinners = potWinners.map(id => room.players.find(p => p.id === id)?.name || id).join(", ");
    const descr = winnersHands[0]?.descr || "Winning hand";
    const hand = winnersHands[0]?.name || "Best hand";
    notes.push(`Pot ${pot.amount} -> ${prettyWinners} (${descr})`);
    
    // Store winner info if this is the main pot (or first pot)
    if (winners.length === 0) {
      winners.push({
        playerIds: potWinners,
        playerNames: prettyWinners,
        hand: hand,
        description: descr,
        amount: pot.amount
      });
    }
  }

  // Apply payouts
  for (const [id, amt] of payouts.entries()) {
    const p = room.players.find(p => p.id === id);
    if (p) p.stack += amt;
  }

  // Log hands and payouts
  for (const p of room.players) {
    if (p.folded) continue;
    const h = solvedById.get(p.id);
    addLog(room, `${p.name} shows ${p.hole.map(prettyCard).join(" ")} (${h.name}: ${h.descr})`);
  }
  for (const line of notes) addLog(room, line);

  // Store winner info for UI
  if (winners.length > 0) {
    room.winnerInfo = winners[0];
  }
  
  room.handOverAt = Date.now();
}

function awardPotTo(room, player) {
  player.stack += room.pot;
  addLog(room, `${player.name} wins the pot (${room.pot}) — everyone else folded.`);

  // Use reveal state so clients display a short reveal animation even when
  // the win is from everyone else folding.
  room.state = "reveal";
  room.currentSeat = null;
  room.winnerInfo = {
    playerIds: [player.id],
    playerNames: player.name,
    hand: "Winning hand",
    description: "Everyone else folded",
    amount: room.pot
  };
  room.handOverAt = Date.now();

  // Broadcast reveal immediately, then resolve showdown after a brief delay
  broadcastRoom(io, room);
  setTimeout(() => {
    const rr = rooms.get(room.code);
    if (!rr) return;
    resolveShowdown(rr);
    rr.state = "showdown";
    rr.currentSeat = null;
    broadcastRoom(io, rr);

    // Auto-start next hand (same behavior as normal showdown path)
      setTimeout(() => {
        const r2 = rooms.get(room.code);
        if (!r2) return;
        r2.state = "lobby";
        r2.stage = "preflop";
        for (const pl of r2.players) {
          pl.folded = pl.stack <= 0;
          pl.allIn = false;
          pl.betThisRound = 0;
          pl.committed = 0;
          pl.hole = [];
          pl.hasActed = false;
          pl.lastAction = null;
        }
      const seats = activeSeats(r2);
      if (seats.length >= 2) {
        r2.state = "hand";
        beginHand(r2);
      } else {
        addLog(r2, "Waiting for at least 2 players with chips to continue.");
      }
      broadcastRoom(io, r2);
    }, 3500);
  }, 3000);
}

function beginHand(room) {
  const seats = activeSeats(room);
  if (seats.length < 2) {
    room.state = "lobby";
    addLog(room, "Need at least 2 players with chips to start.");
    return;
  }

  // Move dealer button to next active seat
  if (room.dealerSeat === null || room.dealerSeat === undefined) room.dealerSeat = seats[0];
  else {
    // ensure dealerSeat is on an active seat; if not, move to next
    if (!seats.includes(room.dealerSeat)) room.dealerSeat = seats[0];
    else room.dealerSeat = nextActiveSeat(room, room.dealerSeat, { includeAllIn: true, includeFolded: true, requireStack: true });
  }

  resetForNewHand(room);

  const { bbSeat } = postBlinds(room);
  dealHoleCards(room);

  // Preflop betting: start at UTG (or dealer if heads-up)
  room.currentSeat = firstToActPreflop(room, bbSeat);
  addLog(room, `Hand started. Dealer: seat ${room.dealerSeat}. Action on seat ${room.currentSeat}.`);
}

function moveToNextActor(room) {
  const next = nextActiveSeat(room, room.currentSeat, { includeAllIn: false, includeFolded: false, requireStack: true });
  room.currentSeat = next;
  room.lastActionAt = Date.now();
}

function sanitizeFor(room, viewerId) {
  const viewer = room.players.find(p => p.id === viewerId);
  const isSpectator = viewer && viewer.stack <= 0;
  
  // Calculate equity for spectators - includes hand names
  let equityInfo = null;
  if (isSpectator && room.state === "hand") {
    equityInfo = calculateHandEquity(room);
  }
  
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,        // lobby | hand | showdown
    stage: room.stage,        // preflop | flop | turn | river
    dealerSeat: room.dealerSeat,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    pot: room.pot,
    community: room.community,
    currentSeat: room.currentSeat,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    players: seatedPlayers(room).map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      folded: p.folded,
      allIn: p.allIn,
      betThisRound: p.betThisRound,
      committed: p.committed,
      connected: p.connected,
      hole: (room.state === "showdown" || room.state === "reveal" || p.id === viewerId || isSpectator) ? p.hole : (p.hole.length ? ["??","??"] : []),
      handRank: isSpectator && room.state === "hand" && p.hole && p.hole.length === 2 && !p.folded ? getHandRank(room.community, p.hole) : null,
    })),
    you: {
      id: viewerId,
      seat: seatOfPlayer(room, viewerId),
      isSpectator: isSpectator,
    },
    equityInfo: equityInfo,
    winnerInfo: room.winnerInfo,
    log: room.log.slice(-40),
    ts: Date.now(),
  };
}

function broadcastRoom(io, room) {
  for (const p of room.players) {
    io.to(p.id).emit("roomState", sanitizeFor(room, p.id));
  }
  // If there's a bot whose turn it is, schedule its action
  try { scheduleBotIfNeeded(room); } catch (e) { /* swallow */ }
}

// --- Bot support ---
function isBotPlayer(p) {
  return !!p.bot;
}

function scheduleBotIfNeeded(room) {
  if (room.state !== 'hand' || room.currentSeat === null) return;
  const p = room.players.find(x => x.seat === room.currentSeat);
  if (!p || !isBotPlayer(p)) return;
  if (room.botTimer) return; // already scheduled

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    const bot = room.players.find(x => x.seat === room.currentSeat);
    if (!bot) return;
    if (bot.folded || bot.allIn) return;

    const callAmount = Math.max(0, room.currentBet - bot.betThisRound);

    // Simple heuristics
    if (callAmount === 0) {
      // decide to check or bet
      if (Math.random() < 0.35 && bot.stack > room.bigBlind) {
        const desired = Math.min(bot.betThisRound + room.bigBlind, bot.betThisRound + bot.stack);
        handlePlayerAction(room, bot, 'bet', desired, true);
      } else {
        handlePlayerAction(room, bot, 'call', undefined, true); // acts as check when callAmount==0
      }
    } else {
      // decide to call or fold
      const affordable = Math.min(callAmount, bot.stack);
      if (callAmount <= Math.max(1, Math.floor(bot.stack * 0.25)) || Math.random() < 0.25) {
        handlePlayerAction(room, bot, 'call', undefined, true);
      } else {
        handlePlayerAction(room, bot, 'fold', undefined, true);
      }
    }
  }, 800 + Math.floor(Math.random() * 600));
}

function handlePlayerAction(room, p, action, amount, isBot = false) {
  // Mirror logic from socket handler but callable for bots
  if (!p) return;
  if (room.state !== "hand") return;
  if (room.currentSeat === null) return;
  if (p.seat !== room.currentSeat) return;
  if (p.folded || p.allIn) return;

  const callAmount = Math.max(0, room.currentBet - p.betThisRound);

  action = (action || "").toLowerCase();

  if (action === "fold") {
    p.folded = true;
    p.hasActed = true;
    p.lastAction = "fold";
    addLog(room, `${p.name} folds.`);
  } else if (action === "check") {
    if (callAmount !== 0) return;
    p.hasActed = true;
    p.lastAction = "check";
    addLog(room, `${p.name} checks.`);
  } else if (action === "call") {
    if (callAmount === 0) {
      p.hasActed = true;
      p.lastAction = "check";
      addLog(room, `${p.name} checks.`);
    } else {
      const paid = commitChips(room, p, callAmount);
      p.hasActed = true;
      p.lastAction = p.allIn ? `call all-in ${paid}` : `call ${paid}`;
      addLog(room, `${p.name} calls ${paid}${p.allIn ? " (all-in)" : ""}.`);
    }
  } else if (action === "all-in") {
    // Commit all remaining stack as a bet/raise
    const desiredTotal = p.betThisRound + p.stack;
    if (desiredTotal <= 0) return;

    const prevBet = room.currentBet;
    const toPay = Math.min(p.stack, Math.max(0, desiredTotal - p.betThisRound));
    if (toPay <= 0) return;

    commitChips(room, p, toPay);

    if (desiredTotal > prevBet) {
      room.currentBet = desiredTotal;
      const raiseSize = desiredTotal - prevBet;
      if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
      room.lastAggressorSeat = p.seat;

      for (const other of room.players) {
        if (other.id === p.id) continue;
        if (other.folded || other.allIn) continue;
        other.hasActed = false;
      }
    }

    p.hasActed = true;
    p.lastAction = `all-in to ${room.currentBet}`;
    addLog(room, `${p.name} goes all-in to ${room.currentBet}.`);
  } else if (action === "bet" || action === "raise") {
    const desiredTotal = Math.floor(Number(amount) || 0);
    if (desiredTotal <= 0) return;

    const prevBet = room.currentBet;
    const minTo = prevBet === 0 ? room.bigBlind : prevBet + room.minRaise;

    const maxTotalPossible = p.betThisRound + p.stack;
    const clamped = Math.min(desiredTotal, maxTotalPossible);

    if (clamped < minTo && clamped !== maxTotalPossible) return;

    const toPay = clamped - p.betThisRound;
    if (toPay <= 0) return;

    commitChips(room, p, toPay);

    const raiseSize = clamped - prevBet;
    if (clamped > prevBet) {
      room.currentBet = clamped;
      if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
      room.lastAggressorSeat = p.seat;

      for (const other of room.players) {
        if (other.id === p.id) continue;
        if (other.folded || other.allIn) continue;
        other.hasActed = false;
      }
    }

    p.hasActed = true;
    p.lastAction = p.allIn ? `${action} all-in to ${room.currentBet}` : `${action} to ${room.currentBet}`;
    addLog(room, `${p.name} ${prevBet === 0 ? "bets" : "raises"} to ${room.currentBet}${p.allIn ? " (all-in)" : ""}.`);
  } else {
    return;
  }

  // clear any scheduled bot timer for this room (we will reschedule if needed)
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }

  const survivor = loneSurvivor(room);
  if (survivor) {
    awardPotTo(room, survivor);
    broadcastRoom(io, room);
    return;
  }

  if (shouldEndBettingRound(room)) {
    while (room.state === "hand") {
      const stillCanAct = room.players.some(x => !x.folded && !x.allIn && x.stack >= 0);
      if (stillCanAct && room.stage !== "river") break;
      if (stillCanAct && room.stage === "river") break;

      if (room.stage === "preflop") {
        room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
        addLog(room, `Flop: ${room.community.map(prettyCard).join(" ")}`);
        room.stage = "flop";
      } else if (room.stage === "flop") {
        room.community.push(room.deck.pop());
        addLog(room, `Turn: ${prettyCard(room.community[3])}`);
        room.stage = "turn";
      } else if (room.stage === "turn") {
        room.community.push(room.deck.pop());
        addLog(room, `River: ${prettyCard(room.community[4])}`);
        room.stage = "river";
      } else if (room.stage === "river") {
        room.state = "reveal";
        room.currentSeat = null;
        addLog(room, "Reveal!");
      } else {
        break;
      }

      if (room.state === "showdown") break;
    }

    if (room.state === "hand") {
      advanceStage(room);
    }

    if (room.state === "reveal") {
      broadcastRoom(io, room);

      setTimeout(() => {
        const stillRoom = rooms.get(room.code);
        if (!stillRoom) return;

        resolveShowdown(stillRoom);

        stillRoom.state = "showdown";
        stillRoom.currentSeat = null;
        console.log(`Room ${stillRoom.code}: broadcasting SHOWDOWN with winnerInfo=`, stillRoom.winnerInfo);
        broadcastRoom(io, stillRoom);

        setTimeout(() => {
          const rr = rooms.get(room.code);
          if (!rr) return;
          rr.state = "lobby";
          rr.stage = "preflop";
          for (const pl of rr.players) {
            pl.folded = pl.stack <= 0;
            pl.allIn = false;
            pl.betThisRound = 0;
            pl.committed = 0;
            pl.hole = [];
            pl.hasActed = false;
            pl.lastAction = null;
          }
          const seats = activeSeats(rr);
          if (seats.length >= 2) {
            rr.state = "hand";
            beginHand(rr);
          } else {
            addLog(rr, "Waiting for at least 2 players with chips to continue.");
          }
          broadcastRoom(io, rr);
        }, 3500);
      }, 3000);

      return;
    }

    broadcastRoom(io, room);
    return;
  }

  moveToNextActor(room);
  broadcastRoom(io, room);
  }


// ---- Server ----
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // OK for MVP. Tighten this for production.
});

const rooms = new Map(); // code -> room

io.on("connection", (socket) => {
  socket.on("createLobby", ({ name }) => {
    name = (name || "").trim().slice(0, 20) || "Host";

    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      state: "lobby",
      stage: "preflop",
      dealerSeat: 0,
      smallBlind: 10,
      bigBlind: 20,
      pot: 0,
      community: [],
      deck: [],
      currentSeat: null,
      currentBet: 0,
      minRaise: 20,
      lastAggressorSeat: null,
      log: [],
      createdAt: Date.now(),
      handOverAt: null,
      lastActionAt: Date.now(),
      winnerInfo: null,
      players: [],
    };

    const seat = 0;
    room.players.push({
      id: socket.id,
      name,
      seat,
      stack: STARTING_STACK,
      connected: true,
      folded: false,
      allIn: false,
      betThisRound: 0,
      committed: 0,
      hole: [],
      hasActed: false,
      lastAction: null,
    });

    rooms.set(code, room);
    socket.join(code);
    addLog(room, `${name} created the lobby.`);
    socket.emit("lobbyCreated", { code, playerId: socket.id });
    broadcastRoom(io, room);
  });

  socket.on("joinLobby", ({ code, name }) => {
    code = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    name = (name || "").trim().slice(0, 20) || "Player";

    const room = rooms.get(code);
    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("joinError", { message: "Room is full." });
      return;
    }
    if (room.state !== "lobby") {
      socket.emit("joinError", { message: "Game already started. (MVP only allows joining in the lobby.)" });
      return;
    }

    const seat = assignSeat(room);
    if (seat === null) {
      socket.emit("joinError", { message: "No seats available." });
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      seat,
      stack: STARTING_STACK,
      connected: true,
      folded: false,
      allIn: false,
      betThisRound: 0,
      committed: 0,
      hole: [],
      hasActed: false,
      lastAction: null,
    });

    socket.join(code);
    addLog(room, `${name} joined (seat ${seat}).`);
    socket.emit("joinOk", { code, playerId: socket.id });
    broadcastRoom(io, room);
  });

  socket.on("setBlinds", ({ code, smallBlind, bigBlind }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostId) return;

    const sb = Math.max(1, Math.floor(Number(smallBlind) || room.smallBlind));
    const bb = Math.max(sb + 1, Math.floor(Number(bigBlind) || room.bigBlind));

    room.smallBlind = sb;
    room.bigBlind = bb;
    addLog(room, `Blinds set to ${sb}/${bb}.`);
    broadcastRoom(io, room);
  });

  socket.on("startGame", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostId) return;

    if (room.state !== "lobby" && room.state !== "showdown") return;

    addLog(room, "Game started!");
    beginHand(room);
    broadcastRoom(io, room);
  });

  socket.on("addBot", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostId) return;

    const seat = assignSeat(room);
    if (seat === null) return;

    const botId = `bot:${makeRoomCode(6)}`;
    const botName = `Bot-${Math.floor(Math.random()*9000)+1000}`;
    room.players.push({
      id: botId,
      name: botName,
      seat,
      stack: STARTING_STACK,
      connected: true,
      folded: false,
      allIn: false,
      betThisRound: 0,
      committed: 0,
      hole: [],
      hasActed: false,
      lastAction: null,
      bot: true,
    });

    addLog(room, `${botName} (bot) joined (seat ${seat}).`);
    broadcastRoom(io, room);
  });

  socket.on("chat", ({ code, message }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;

    // Prevent spectators (stack <= 0) from chatting
    if (p.stack <= 0) return;

    message = (message || "").toString().trim().slice(0, 160);
    if (!message) return;

    addLog(room, `${p.name}: ${message}`);
    broadcastRoom(io, room);
  });

  socket.on("playerAction", ({ code, action, amount }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;

    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;

    console.log(`[DEBUG] Player action: ${p.name} - action="${action}", amount=${amount}`);
    handlePlayerAction(room, p, action, amount, false);
  });

  socket.on("disconnect", () => {
    // Mark player disconnected; if they were in a room, update.
    for (const room of rooms.values()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const p = room.players[idx];
      p.connected = false;

      addLog(room, `${p.name} disconnected.`);

      // If lobby, remove them entirely (keeps rooms clean)
      if (room.state === "lobby") {
        room.players.splice(idx, 1);
        addLog(room, `${p.name} left the lobby.`);
      } else {
        // If in-hand and it's their turn, auto-fold
        if (room.state === "hand" && room.currentSeat === p.seat && !p.folded && !p.allIn) {
          p.folded = true;
          p.hasActed = true;
          p.lastAction = "disconnect fold";
          addLog(room, `${p.name} auto-folds (disconnect).`);

          const survivor = loneSurvivor(room);
          if (survivor) awardPotTo(room, survivor);
          else if (shouldEndBettingRound(room)) {
            advanceStage(room);
            if (room.state === "reveal") {
              broadcastRoom(io, room);
              setTimeout(() => {
                const rr = rooms.get(room.code);
                if (!rr) return;
                resolveShowdown(rr);
                rr.state = "showdown";
                rr.currentSeat = null;
                console.log(`Room ${rr.code}: awardPotTo -> broadcasting SHOWDOWN with winnerInfo=`, rr.winnerInfo);
                broadcastRoom(io, rr);

                setTimeout(() => {
                  const r2 = rooms.get(room.code);
                  if (!r2) return;
                  r2.state = "lobby";
                  r2.stage = "preflop";
                  for (const pl of r2.players) {
                    pl.folded = false;
                    pl.allIn = false;
                    pl.betThisRound = 0;
                    pl.committed = 0;
                    pl.hole = [];
                    pl.hasActed = false;
                    pl.lastAction = null;
                  }
                  const seats = activeSeats(r2);
                  if (seats.length >= 2) {
                    r2.state = "hand";
                    beginHand(r2);
                  } else {
                    addLog(r2, "Waiting for at least 2 players with chips to continue.");
                  }
                  broadcastRoom(io, r2);
                }, 3500);
              }, 3000);
            } else if (room.state === "showdown") {
              resolveShowdown(room);
            }
          } else {
            moveToNextActor(room);
          }
        }
      }

      // If host left, assign a new host if any players remain
      if (room.hostId === socket.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
        addLog(room, `${room.players[0].name} is now the host.`);
      }

      // Delete empty rooms
      if (room.players.length === 0) {
        rooms.delete(room.code);
      } else {
        broadcastRoom(io, room);
      }
      break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hold'em MVP running on http://localhost:${PORT}`);
});
