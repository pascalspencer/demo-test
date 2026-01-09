// ==================================
// DERIV MATCHES + HEDGE STRATEGY
// ==================================
import connection from './derivConnection.mjs';

const SYMBOL = "R_25";

// ---- RISK CONFIG ----
const STAKE = 1;
const MAX_MATCH_ATTEMPTS = 5;
const REQUIRED_ABSENCE = 70;
const HISTORY_LIMIT = 120;
const VOLATILITY_THRESHOLD = 0.35; // higher = more chaos

// ---- STATE ----
let tickHistory = [];
let matchAttempts = 0;
let sessionWon = false;
let awaitingHedge = false;
let lastMatchDigit = null;
let unsubscribe = null;

// ===============================
// START
// ===============================

export function startSuperMatches() {
  console.log("Starting Super Matches Strategy...");
  // Reset state
  tickHistory = [];
  matchAttempts = 0;
  sessionWon = false;
  awaitingHedge = false;
  lastMatchDigit = null;

  subscribeTicks();
}

export function stopSuperMatches() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  console.log("Stopped Super Matches Strategy.");
}


// ===============================
// SUBSCRIBE TICKS
// ===============================
function subscribeTicks() {
  unsubscribe = connection.subscribeTicks(SYMBOL, (tick) => {
    processTick(tick);
  });
}

// ===============================
// PROCESS TICK
// ===============================
function processTick(tick) {
  const digit = Number(tick.quote.toString().slice(-1));
  tickHistory.push(digit);
  if (tickHistory.length > HISTORY_LIMIT) tickHistory.shift();

  renderTickCounter();

  if (!canTrade()) return;
  if (isVolatile()) return;

  const matchDigit = selectMatchDigit();
  if (matchDigit !== null) executeMatch(matchDigit);
}

// ===============================
// VISUAL TICK COUNTER
// ===============================
function renderTickCounter() {
  const counts = Array(10).fill(0);
  tickHistory.forEach(d => counts[d]++);

  // Optional: Update UI if this script had a UI attached, currently it logs to console
  // console.clear();
  console.log("📊 DIGIT COUNTER (last", tickHistory.length, "ticks)");
  counts.forEach((c, d) => {
    // console.log(`Digit ${d}: ${"█".repeat(c)} (${c})`);
  });
}

// ===============================
// VOLATILITY DETECTION
// ===============================
function isVolatile() {
  if (tickHistory.length < 50) return true;

  const counts = Array(10).fill(0);
  tickHistory.forEach(d => counts[d]++);

  const mean = tickHistory.length / 10;
  const variance = counts.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / 10;
  const chaos = Math.sqrt(variance) / mean;

  if (chaos > VOLATILITY_THRESHOLD) {
    console.log("⚠️ Volatility too high — trading paused");
    return true;
  }
  return false;
}

// ===============================
// DIGIT SELECTION (MATCH)
// ===============================
function selectMatchDigit() {
  if (tickHistory.length < REQUIRED_ABSENCE) return null;

  const stats = [...Array(10).keys()].map(d => ({
    digit: d,
    lastSeen: [...tickHistory].reverse().indexOf(d),
    freq: tickHistory.filter(x => x === d).length
  }));

  const candidates = stats.filter(
    d => d.lastSeen === -1 || d.lastSeen >= REQUIRED_ABSENCE
  );

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.freq - b.freq);

  return candidates[0].digit;
}

// ===============================
// TRADE CONDITIONS
// ===============================
function canTrade() {
  return !sessionWon && matchAttempts < MAX_MATCH_ATTEMPTS;
}

// ===============================
// EXECUTE MATCH
// ===============================
async function executeMatch(digit) {
  matchAttempts++;
  lastMatchDigit = digit;

  console.log(`🎯 MATCH ${matchAttempts}/${MAX_MATCH_ATTEMPTS} → Digit ${digit}`);

  await sendTrade("DIGITMATCH", digit);
}

// ===============================
// EXECUTE DIFFERS HEDGE
// ===============================
async function executeHedge(digit) {
  console.log(`🛡️ HEDGE → DIFFERS ${digit}`);
  await sendTrade("DIGITDIFF", digit);
}

// ===============================
// SEND TRADE
// ===============================
async function sendTrade(type, digit) {
  // Use similar logic to buyContract but locally tailored for this script
  // Or reuse connection directly

  try {
    const proposal = {
      proposal: 1,
      amount: STAKE,
      basis: "stake",
      contract_type: type,
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      symbol: SYMBOL,
      barrier: String(digit)
    };

    const propResp = await connection.send(proposal);
    if (propResp.error) return handleResult({ error: propResp.error });

    const buyResp = await connection.send({
      buy: propResp.proposal.id,
      price: propResp.proposal.ask_price
    });

    if (buyResp.error) return handleResult({ error: buyResp.error });

    // Wait for result via proposal_open_contract not supported easily here without subscription
    // For simplicity, we assume we need to wait / poll or logic needs to be robust
    // But since this script was using "proposal_open_contract" subscription, let's replicate waiting

    await waitForContractResult(buyResp.buy.contract_id);

  } catch (e) {
    console.error("Trade Error", e);
  }
}

async function waitForContractResult(contractId) {
  // Poll for result
  let retries = 0;
  while (retries < 20) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const poc = await connection.send({ proposal_open_contract: 1, contract_id: contractId });
      const contract = poc.proposal_open_contract;
      if (contract.is_sold) {
        handleResult(contract);
        return;
      }
    } catch (e) { }
    retries++;
  }
}

// ===============================
// HANDLE RESULT
// ===============================
function handleResult(contract) {
  if (contract.error) {
    console.log("❌ Trade Error");
    return;
  }

  if (contract.profit > 0) {
    console.log("✅ WIN → Session complete");
    sessionWon = true;
    stopSuperMatches();
  } else {
    console.log("❌ LOSS");

    if (!awaitingHedge && lastMatchDigit !== null) {
      awaitingHedge = true;
      executeHedge(lastMatchDigit);
    } else {
      awaitingHedge = false;
    }
  }
}
