import { buyContract } from "./buyContract.mjs";
import connection from './derivConnection.mjs';

let running = false;
let checkingForEntry = false;
let unsubscribeTicks = null;
let tickHistory = [];
let tickCountInput, stakeInput, tickGrid, totalTicksDisplay, resultsDisplay;
let completedTrades = 0;
let maxTradesPerSession = 100; // safety cap

document.addEventListener("DOMContentLoaded", () => {
  // Create Even/Odd Panel
  document.body.insertAdjacentHTML("beforeend", `
    <div id="even-odd-panel" style="display: none;">
      <div class="smart-card">
        <div class="smart-header">
          <h2 class="smart-title">Even / Odd Switch</h2>
          <p class="smart-sub">Pattern-based digit trading</p>
        </div>

        <div class="smart-form">
          <div class="tick-display">
            <div class="tick-header">Live Tick Stream (Last 50)</div>
            <div class="tick-grid" id="tick-grid-eo">
              <!-- Ticks will be populated here -->
            </div>
            <div class="tick-count-display">
              Total Ticks: <span id="total-ticks-eo">0</span>
            </div>
          </div>

          <div class="field">
            <label for="tick-count-eo">Number of trades</label>
            <input type="number" id="tick-count-eo" min="1" value="5">
          </div>

          <div class="stake-row">
            <button id="run-even-odd" class="run-btn">RUN</button>
            <div class="field stake-field">
              <label for="stake-eo">(Minimum 0.35)</label>
              <input type="number" id="stake-eo" min="0.35" step="0.01" value="0.35">
            </div>
          </div>

          <div id="even-odd-results" class="smart-results"></div>
        </div>
      </div>
    </div>
  `);

  // Get elements
  tickCountInput = document.getElementById("tick-count-eo");
  stakeInput = document.getElementById("stake-eo");
  tickGrid = document.getElementById("tick-grid-eo");
  totalTicksDisplay = document.getElementById("total-ticks-eo");
  resultsDisplay = document.getElementById("even-odd-results");

  // Event listeners
  document.getElementById("run-even-odd").onclick = runEvenOdd;

  // Add market and submarket change listeners
  const marketSelect = document.getElementById("market");
  const submarketSelect = document.getElementById("submarket");

  if (marketSelect) {
    marketSelect.addEventListener("change", () => {
      console.log("Market changed, restarting stream...");
      restartTickStream();
    });
  }

  if (submarketSelect) {
    submarketSelect.addEventListener("change", () => {
      console.log("Submarket changed, restarting stream...");
      restartTickStream();
    });
  }

  // Initialize tick display and start streaming
  updateTickDisplay();
  startTickStream();
});

function updateTickDisplay() {
  tickGrid.innerHTML = '';
  const displayTicks = tickHistory.slice(-50);

  // Create a 5x10 grid
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) {
      const tickIndex = row * 10 + col;
      const tickEl = document.createElement('div');
      tickEl.className = 'tick-item';

      if (tickIndex < displayTicks.length) {
        const tick = displayTicks[tickIndex];
        tickEl.textContent = tick;
        if (tick % 2 === 0) {
          tickEl.classList.add('even');
        } else {
          tickEl.classList.add('odd');
        }
        if (tickIndex === displayTicks.length - 1) {
          tickEl.classList.add('new-tick');
        }
      } else {
        tickEl.classList.add('empty');
      }
      tickGrid.appendChild(tickEl);
    }
  }
  totalTicksDisplay.textContent = tickHistory.length;
}

function startTickStream() {
  const market = document.getElementById("market")?.value;
  const submarket = document.getElementById("submarket")?.value;

  if (!market || !submarket) {
    setTimeout(startTickStream, 1000);
    return;
  }

  const symbol = submarket;

  // Use connection manager
  if (unsubscribeTicks) unsubscribeTicks(); // clear old sub

  unsubscribeTicks = connection.subscribeTicks(symbol, (tick) => {
    const quote = tick.quote;
    const digit = Number(String(quote).slice(-1));
    tickHistory.push(digit);

    if (tickHistory.length > 100) {
      tickHistory = tickHistory.slice(-100);
    }

    updateTickDisplay();

    if (checkingForEntry && tickHistory.length >= 3) {
      checkForPatternAndTrade();
    }
  });

  console.log("Subscribed to ticks for:", symbol);
}

function stopTickStream() {
  if (unsubscribeTicks) {
    unsubscribeTicks();
    unsubscribeTicks = null;
  }
}

function restartTickStream() {
  stopTickStream();
  tickHistory = [];
  updateTickDisplay();
  setTimeout(() => startTickStream(), 1000);
}


async function runEvenOdd() {
  if (running) {
    stopEvenOdd();
    return;
  }

  completedTrades = 0;
  running = true;
  checkingForEntry = true;

  resultsDisplay.dataset.success = "0";
  resultsDisplay.dataset.failed = "0";

  document.getElementById("run-even-odd").textContent = "STOP";
  resultsDisplay.innerHTML = "Monitoring Even / Odd ticks...";

  popup("Checking Stream", "Waiting for entry pattern", 1500);

  if (tickHistory.length >= 3) {
    checkForPatternAndTrade();
  }
}

async function checkForPatternAndTrade() {
  if (!running || !checkingForEntry) return;

  const numTrades = parseInt(tickCountInput.value) || 5;
  if (completedTrades >= numTrades) return finishSession();

  const last3 = tickHistory.slice(-3);
  if (last3.length < 3) return;

  const allEven = last3.every(d => d % 2 === 0);
  const allOdd = last3.every(d => d % 2 !== 0);
  if (!allEven && !allOdd) return;

  // Pattern Found
  checkingForEntry = false; // Stop checking while we trade

  const tradeType = allEven ? "DIGITEVEN" : "DIGITODD";
  const pattern = allEven ? "Even" : "Odd";
  const stake = Number(stakeInput.value);
  const symbol = document.getElementById("submarket")?.value || "R_100";
  const lastDigit = last3[2];

  resultsDisplay.innerHTML = `Pattern detected: <b>${pattern}</b><br>Executing trade...`;

  try {
    const result = await buyContract(symbol, tradeType, 1, stake, null, null, true);
    const payout = Number(result?.buy?.payout || 0);
    const win = payout > stake;

    completedTrades++;

    const s = Number(resultsDisplay.dataset.success) + (win ? 1 : 0);
    const f = Number(resultsDisplay.dataset.failed) + (win ? 0 : 1);
    resultsDisplay.dataset.success = String(s);
    resultsDisplay.dataset.failed = String(f);

    popup(
      "Trade Executed",
      `Type: ${tradeType}<br>Stake: $${stake.toFixed(2)}<br>Last Digit: ${lastDigit}<br>Result: ${win ? 'WON' : 'LOST'}`,
      2000
    );

    resultsDisplay.innerHTML = `
            <strong>Trading Active</strong><br>
            Pattern: ${pattern}<br>
            Completed: ${completedTrades}/${numTrades}<br>
            Wins: ${s}, Losses: ${f}
        `;

    if (completedTrades < numTrades) {
      // small delay before looking for patterns again
      setTimeout(() => {
        checkingForEntry = true;
      }, 500);
    } else {
      finishSession();
    }

  } catch (err) {
    completedTrades++;
    popup("Trade Error", err.message, 3000);
    // continue if error
    setTimeout(() => { checkingForEntry = true; }, 500);
  }
}

function finishSession() {
  running = false;
  checkingForEntry = false;
  document.getElementById("run-even-odd").textContent = "RUN";

  popup(
    "Even / Odd Complete",
    `Trades: ${completedTrades}<br>
     Wins: ${resultsDisplay.dataset.success}<br>
     Losses: ${resultsDisplay.dataset.failed}`,
    4000
  );
}


function stopEvenOdd() {
  running = false;
  checkingForEntry = false;
  document.querySelector('.trade-popup-overlay')?.remove();
  document.getElementById("run-even-odd").textContent = "RUN";
  popup("Even / Odd Stopped");
}

function popup(msg, details = null, timeout = 2000) {
  try {
    const overlay = document.createElement('div');
    overlay.className = 'trade-popup-overlay';
    const popup = document.createElement('div');
    popup.className = 'trade-popup';
    const title = document.createElement('h3');
    title.textContent = msg;
    popup.appendChild(title);
    if (details) {
      const p = document.createElement('p');
      p.innerHTML = details;
      popup.appendChild(p);
    }
    const closeBtn = document.createElement('a');
    closeBtn.className = 'close-btn';
    closeBtn.href = '#';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', (ev) => { ev.preventDefault(); try { overlay.remove(); } catch (e) { } });
    popup.appendChild(closeBtn);
    overlay.appendChild(popup);
    try { document.body.appendChild(overlay); } catch (e) { }
    if (timeout > 0) setTimeout(() => { try { overlay.remove(); } catch (e) { } }, timeout);
  } catch (e) { }
}