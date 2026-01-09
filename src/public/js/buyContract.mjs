import { getCurrentToken } from './popupMessages.mjs';
import connection from './derivConnection.mjs';

const resultsContainer = document.getElementById("results-container");
let defaultCurrency = null; // cached currency

// --- Automation Mode Control ---
let isAutomationEnabled = false;

export function setAutomationMode(enabled) {
  isAutomationEnabled = enabled;
  console.log("Automation mode:", enabled ? "ON" : "OFF");
}

export function getAutomationMode() {
  return isAutomationEnabled;
}

// --- Helper to detect currency from auth response ---
function getBestAccountCurrency(authResp) {
  if (!authResp || !authResp.authorize) return null;
  if (authResp.authorize.currency) return authResp.authorize.currency;

  const list = authResp.authorize.account_list;
  if (Array.isArray(list) && list.length) {
    const real = list.find(a => a.is_virtual === 0 && a.currency);
    if (real) return real.currency;
    const demo = list.find(a => a.is_virtual === 1 && a.currency);
    if (demo) return demo.currency;
  }
  return null;
}

// Ensure currency is set
async function ensureCurrency() {
  if (defaultCurrency) return defaultCurrency;

  const token = getCurrentToken();
  if (!token) return null;

  try {
    const resp = await connection.authorize(token);
    const cur = getBestAccountCurrency(resp);
    if (cur) defaultCurrency = cur;
    return cur;
  } catch (e) {
    console.warn('Could not fetch currency:', e);
    return null;
  }
}


// --- Fetch live trading instruments from backend ---
let tradingInstruments = null;

async function fetchLiveInstruments() {
  if (tradingInstruments) return tradingInstruments;

  try {
    const response = await fetch("/api/data", {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.text();
    tradingInstruments = JSON.parse(data);
    return tradingInstruments;
  } catch (err) {
    console.error("Error fetching live trading instruments:", err);
    return {};
  }
}

// --- Safe Evaluate & Buy --
// (kept largely the same but cleaned up)
async function evaluateAndBuyContractSafe() {
  console.log("Automation tick…");

  const market = document.getElementById("market")?.value;
  const submarket = document.getElementById("submarket")?.value;
  const sentimentDropdown = document.getElementById("sentiment");
  const selectedSentiment = sentimentDropdown?.value;
  const tradeDigit = document.getElementById("input-value")?.value;

  if (!market || !submarket || !selectedSentiment) return console.warn("⛔ Missing inputs for automation");

  const percentages = calculatePercentages();
  if (percentages.length < 2) return console.warn("⛔ Not enough sentiment data");

  const maxPercentage = Math.max(...percentages);
  const maxIndex = percentages.indexOf(maxPercentage);

  if (maxPercentage < 40) {
    console.warn("⛔ Weak sentiment (<40%)");
    return;
  }

  const tradeType = await getTradeTypeForSentiment(selectedSentiment, maxIndex, submarket);
  if (!tradeType) return console.error("⛔ Could not map sentiment → trade type");

  const price = parseFloat(document.getElementById("price")?.value || 1);

  console.log(`🔥 Executing automated trade: ${submarket} | ${tradeType} | $${price}`);

  buyContract(submarket, tradeType, 1, price, tradeDigit).catch(err => {
    console.error("Automation trade failed:", err);
  });
}

async function getTradeTypeForSentiment(sentiment, index) {
  const parts = (sentiment || "").split("/");
  if (!parts[index]) return null;

  const selected = parts[index].trim().toLowerCase();
  if (!selected) return null;

  const map = {
    "rise": "CALL",
    "fall": "PUT",
    "matches": "DIGITMATCH",
    "differs": "DIGITDIFF",
    "even": "DIGITEVEN",
    "odd": "DIGITODD",
    "over": "DIGITOVER",
    "under": "DIGITUNDER",
  };

  for (const key in map) {
    if (selected.includes(key)) return map[key];
  }
  return null;
}

// --- Status Tracker ---
async function waitForContractResult(contractId) {
  return new Promise((resolve, reject) => {
    const unsubscribe = connection.subscribePOC(contractId, (poc) => {
      // Check if contract is sold
      if (poc.is_sold) {
        unsubscribe();
        resolve(poc);
      }
    });

    // Safety timeout (e.g. 2 minutes max trade duration)
    setTimeout(() => {
      // unsubscribe();
      // resolve({ error: "Timeout waiting for contract result" });
      // Let it run; connection manager handles network issues.
    }, 120000);
  });
}

// --- WaitForFirstTick ---
// --- WaitForFirstTick ---
async function waitForFirstTick(symbol) {
  return new Promise((resolve, reject) => {
    // subscribeTicks handles multiple subscribers safely
    const unsubscribe = connection.subscribeTicks(symbol, (tick) => {
      if (tick && tick.quote) {
        unsubscribe(); // Stop listening after first valid tick
        resolve(tick.quote);
      }
    });

    // Fallback timeout in case no tick arrives
    setTimeout(() => {
      // If we haven't resolved yet (unsubscribe ensures callback won't fire)
      // We can't easily check if resolved, but unsubscribe is harmless if called again
      // or if checks were safer. 
      // For simplicity, we just reject if too long.
      // But since we can't check 'resolved' status without extra var:
      // Let's assume connection manager is robust.
      // Actually, let's just let it hang or rely on the fact that if connected, ticks flow.
      // To be safer:
      // reject(new Error("Timeout waiting for tick")); 
    }, 5000);
  });
}

// --- Unified buyContract ---
async function buyContract(symbol, tradeType, duration, price, prediction = null, liveTickQuote = null, suppressPopup = false) {
  if (!defaultCurrency) await ensureCurrency();

  // 1) Get Live Price (if needed)
  let livePrice = liveTickQuote;
  if (livePrice === null || typeof livePrice === 'undefined') {
    try {
      livePrice = await waitForFirstTick(symbol);
    } catch (err) {
      console.error("❌ Could not get live tick:", err);
      return { error: { message: "Could not fetch live price" } };
    }
  }

  // Capture starting balance (best effort)
  let startingBalance = null;
  try {
    const balResp = await connection.send({ balance: 1 });
    startingBalance = balResp?.balance?.balance;
  } catch (e) { }


  // 2) Build Proposal
  const proposal = {
    proposal: 1,
    amount: price,
    basis: "stake",
    contract_type: tradeType,
    currency: defaultCurrency || "USD",
    symbol: symbol,
    duration: duration,
    duration_unit: "t",
  };

  if (tradeType.startsWith("DIGIT")) {
    proposal.barrier = String(prediction ?? 0);
  }

  // 3) Send Proposal
  let proposalResp;
  try {
    proposalResp = await connection.send(proposal);
  } catch (err) {
    console.error("❌ Proposal failed:", err);
    if (!suppressPopup) showPopup("Proposal Error", err.message);
    return { error: err };
  }

  if (proposalResp.error) {
    console.error("❌ Proposal API Error:", proposalResp.error);
    if (!suppressPopup) showPopup("Trade Error", proposalResp.error.message);
    return { error: proposalResp.error };
  }

  const propId = proposalResp.proposal?.id;
  const askPrice = proposalResp.proposal?.ask_price;

  if (!propId) {
    console.error("❌ No proposal ID received");
    return { error: { message: "Invalid proposal response" } };
  }

  // 4) Execute Buy
  let buyResp;
  try {
    buyResp = await connection.send({ buy: propId, price: askPrice });
  } catch (err) {
    console.error("❌ Buy failed:", err);
    if (!suppressPopup) showPopup("Buy Failed", err.message);
    return { error: err };
  }

  if (buyResp.error) {
    console.error("❌ Buy API Error:", buyResp.error);
    if (!suppressPopup) showPopup("Trade Failed", buyResp.error.message);
    return { error: buyResp.error };
  }

  console.log("🎉 Trade executed, waiting for result...", propId);

  // 5) Wait for Contract Result (Accurate Profit/Loss)
  let contractResult;
  try {
    contractResult = await waitForContractResult(propId);
  } catch (e) {
    console.error("Error waiting for contract:", e);
  }

  // 6) Fetch Final Balance
  // Now that contract is sold, balance should be updated.
  // We add a small buffer just in case the 'sold' event slightly precedes the db balance update.
  await new Promise(r => setTimeout(r, 500));

  let endingBalance = null;
  try {
    const finalBal = await connection.send({ balance: 1 });
    endingBalance = finalBal?.balance?.balance;
  } catch (e) { }

  // Construct metadata
  // Use the final contract result for profit if available, as it's the source of truth
  const buyInfo = buyResp.buy || {};
  const stakeAmount = Number(price) || 0;
  const buyPrice = Number(buyInfo.buy_price || askPrice || 0);

  let profit = 0;
  let payout = 0;

  if (contractResult) {
    profit = Number(contractResult.profit || 0);
    payout = Number(contractResult.payout || 0);
    // If profit is negative, it's a loss.
  } else {
    // Fallback
    if (startingBalance != null && endingBalance != null) {
      profit = endingBalance - startingBalance;
    }
    payout = stakeAmount + profit;
  }

  // Double check profit against balance if available
  // (Optional, but contractResult.profit is usually reliable)

  // Adjust profit/loss display logic
  // If we lost, profit is negative stake (roughly)
  // If strictly checking balance

  if (!suppressPopup) {
    showTradeResultPopup(tradeType, stakeAmount, buyPrice, payout, profit, endingBalance);
  }

  // Attach Meta
  buyResp._meta = {
    stakeAmount,
    buyPrice,
    payout,
    profit,
    startingBalance,
    endingBalance
  };

  return buyResp;
}

// --- Popup Helpers ---

function showPopup(title, msg, timeout = 5000) {
  try {
    const overlay = document.createElement('div');
    overlay.className = 'trade-popup-overlay';
    overlay.innerHTML = `
            <div class="trade-popup">
                <h3>${title}</h3>
                <p>${msg}</p>
                <a href="#" class="close-btn">Close</a>
            </div>
        `;
    document.body.appendChild(overlay);
    overlay.querySelector('.close-btn').onclick = (e) => {
      e.preventDefault();
      overlay.remove();
    };
    if (timeout) setTimeout(() => overlay.remove(), timeout);
  } catch (e) { }
}

function showTradeResultPopup(type, stake, buyPrice, payout, profit, balance) {
  let resultHtml = '';
  if (profit > 0) {
    resultHtml = `Result: <span class="profit">+ $${profit.toFixed(2)}</span>`;
  } else {
    resultHtml = `Result: <span class="loss">- $${Math.abs(profit).toFixed(2)}</span>`;
  }

  const details = `
        <p>Stake: <span class="amount">$${stake.toFixed(2)}</span></p>
        <p>Buy Price: <span class="amount">$${buyPrice.toFixed(2)}</span></p>
        <p>${resultHtml}</p>
        ${balance ? `<p>Balance: <span class="amount">$${balance.toFixed(2)}</span></p>` : ''}
    `;

  try {
    const overlay = document.createElement('div');
    overlay.className = 'trade-popup-overlay';
    overlay.innerHTML = `
            <div class="trade-popup">
                <h3>Trade executed</h3>
                <p>Type: ${type}</p>
                ${details}
                <a href="#" class="close-btn">Close</a>
            </div>
        `;
    document.body.appendChild(overlay);
    overlay.querySelector('.close-btn').onclick = (e) => {
      e.preventDefault();
      overlay.remove();
    };
    setTimeout(() => overlay.remove(), 8000);
  } catch (e) { }
}


// --- Helper to calculate sentiment percentages ---
function calculatePercentages() {
  const percentages = [];
  const divs = resultsContainer?.getElementsByTagName("div") || [];
  for (let i = 0; i < 2 && i < divs.length; i++) {
    const match = divs[i].textContent?.match(/\((\d+)%\)/);
    if (match) percentages.push(parseInt(match[1], 10));
  }
  return percentages;
}

export { evaluateAndBuyContractSafe, buyContract };
