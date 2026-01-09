import { buyContract } from "./buyContract.mjs";
import { getCurrentToken } from './popupMessages.mjs';
import connection from './derivConnection.mjs';

let running = false;
let ticksSeen = 0;
let tradeLock = false;
let unsubscribeTicks = null; // function to stop tick subscription

let overDigit, underDigit, tickCount, stakeInput;
let singleToggle, bulkToggle, resultsBox;

document.addEventListener("DOMContentLoaded", () => {
  // UI Injection
  document.body.insertAdjacentHTML("beforeend", `
  <div id="smart-over-under" style="display:none">
    <div class="smart-card">
      <div class="smart-header">
        <h2 class="smart-title">Smart Over / Under</h2>
        <p class="smart-sub">Automated digit strategy</p>
      </div>

      <div class="smart-form">
        <div class="row two-cols">
          <div class="field">
            <label for="over-digit">Over</label>
            <select id="over-digit"></select>
          </div>

          <div class="field">
            <label for="under-digit">Under</label>
            <select id="under-digit"></select>
          </div>
        </div>

        <div class="field">
          <label for="tick-count">Number of ticks</label>
          <input type="number" id="tick-count" min="1" value="5">
        </div>

        <div class="toggle-container">
          <label class="small-toggle">
            <span>Single</span>
            <input type="checkbox" id="single-toggle" checked>
          </label>
          <label class="small-toggle">
            <span>Bulk</span>
            <input type="checkbox" id="bulk-toggle">
          </label>
        </div>

        <div class="stake-row">
          <div class="field stake-field">
            <label for="stake">(Minimum 0.35)</label>
            <input type="number" id="stake" min="0.35" step="0.01" value="0.35">
          </div>

          <div class="smart-buttons">
            <button id="run-smart">RUN</button>
            <button id="stop-smart">STOP</button>
          </div>
        </div>

<div id="smart-results" class="smart-results"></div>
      </div>
    </div>
  </div>
`);


  overDigit = document.getElementById("over-digit");
  underDigit = document.getElementById("under-digit");
  tickCount = document.getElementById("tick-count");
  stakeInput = document.getElementById("stake");
  singleToggle = document.getElementById("single-toggle");
  bulkToggle = document.getElementById("bulk-toggle");
  resultsBox = document.getElementById("smart-results");

  for (let i = 0; i <= 9; i++) {
    overDigit.innerHTML += `<option value="${i}">${i}</option>`;
    underDigit.innerHTML += `<option value="${i}">${i}</option>`;
  }

  function updateToggles() {
    if (singleToggle.checked) {
      bulkToggle.checked = false;
      bulkToggle.disabled = true;
    } else {
      bulkToggle.disabled = false;
    }

    if (bulkToggle.checked) {
      singleToggle.checked = false;
      singleToggle.disabled = true;
    } else {
      singleToggle.disabled = false;
    }
  }

  singleToggle.addEventListener('change', updateToggles);
  bulkToggle.addEventListener('change', updateToggles);
  updateToggles();

  const marketEl = document.getElementById("market");
  const submarketEl = document.getElementById("submarket");
  const originalPos = {
    market: marketEl ? { parent: marketEl.parentNode, next: marketEl.nextSibling } : null,
    submarket: submarketEl ? { parent: submarketEl.parentNode, next: submarketEl.nextSibling } : null,
  };

  const smartContainer = document.getElementById("smart-over-under");
  let smartHeadingEl = null;

  function showSmartMode() {
    document.body.classList.add('smart-mode');
    if (marketEl && marketEl.parentNode !== smartContainer) {
      smartContainer.insertBefore(marketEl, smartContainer.firstChild);
    }
    if (submarketEl && submarketEl.parentNode !== smartContainer) {
      smartContainer.insertBefore(submarketEl, marketEl && marketEl.parentNode === smartContainer ? marketEl.nextSibling : smartContainer.firstChild);
    }
    smartContainer.classList.add('visible');
  }

  function hideSmartMode() {
    document.body.classList.remove('smart-mode');
    if (originalPos.market && marketEl) {
      originalPos.market.parent.insertBefore(marketEl, originalPos.market.next);
    }
    if (originalPos.submarket && submarketEl) {
      originalPos.submarket.parent.insertBefore(submarketEl, originalPos.submarket.next);
    }
    smartContainer.classList.remove('visible');
  }

  let lastVisible = window.getComputedStyle(smartContainer).display !== 'none';
  const visibilityPoll = setInterval(() => {
    const visible = window.getComputedStyle(smartContainer).display !== 'none';
    if (visible === lastVisible) return;
    lastVisible = visible;
    if (visible) showSmartMode(); else hideSmartMode();
  }, 250);

  window.addEventListener('beforeunload', () => clearInterval(visibilityPoll));

  document.getElementById("run-smart").onclick = runSmart;
  document.getElementById("stop-smart").onclick = stopSmart;
});

function popup(msg, details = null, timeout = 2000) {
  // reusing existing popup logic simply
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

async function runSmart() {
  if (running) return;
  running = true;
  ticksSeen = 0;
  tradeLock = false;
  resultsBox.innerHTML = "";

  popup("Checking Entry...");

  const symbol = document.getElementById("submarket")?.value || "R_100";

  if (bulkToggle.checked) {
    await runBulkOnce(symbol);
    running = false;
    return;
  }

  if (singleToggle.checked) {
    await runSingleSequential(symbol);
    running = false;
    return;
  }
}

// Sequential buys driven by ticks
async function runSingleSequential(symbol) {
  ticksSeen = 0;
  return new Promise((resolve) => {
    // Subscribe using the connection manager
    unsubscribeTicks = connection.subscribeTicks(symbol, (tick) => {
      if (!running) {
        if (unsubscribeTicks) unsubscribeTicks();
        resolve();
        return;
      }

      const quote = tick.quote;
      const digit = Number(String(quote).slice(-1));

      if (tradeLock) return;

      if (digit < Number(overDigit.value)) {
        tradeLock = true;
        executeTrade(symbol, "DIGITOVER", overDigit.value, quote).finally(() => {
          tradeLock = false;
          ticksSeen++;
        });
      } else if (digit > Number(underDigit.value)) {
        tradeLock = true;
        executeTrade(symbol, "DIGITUNDER", underDigit.value, quote).finally(() => {
          tradeLock = false;
          ticksSeen++;
        });
      }

      if (ticksSeen >= Number(tickCount.value)) {
        finishSmart();
        resolve();
      }
    });

    if (!unsubscribeTicks) {
      // safety if connection failed immediately
      running = false;
      resolve();
    }
  });
}

// Bulk mode
async function runBulkOnce(symbol) {
  return new Promise((resolve) => {
    ticksSeen = 0;

    unsubscribeTicks = connection.subscribeTicks(symbol, async (tick) => {
      if (!running) {
        if (unsubscribeTicks) unsubscribeTicks();
        resolve();
        return;
      }

      const quote = tick.quote;
      const digit = Number(String(quote).slice(-1));

      if (tradeLock) return;

      let tradeType = null;
      let barrier = 0;

      if (digit < Number(overDigit.value)) {
        tradeType = "DIGITOVER";
        barrier = overDigit.value;
      } else if (digit > Number(underDigit.value)) {
        tradeType = "DIGITUNDER";
        barrier = underDigit.value;
      }

      if (!tradeType) return;

      tradeLock = true;

      // Execute buys
      const n = Math.max(1, Number(tickCount.value) || 1);
      const stake = stakeInput.value;

      // We use the shared buyContract function which now queues correctly via connection manager
      const buys = Array.from({ length: n }, () => buyContract(symbol, tradeType, 1, stake, barrier, quote, true));

      let results = [];
      try {
        results = await Promise.allSettled(buys);
      } catch (e) { }

      let success = 0, failed = 0;
      results.forEach(r => {
        if (r.status === 'fulfilled' && !(r.value && r.value.error)) success++; else failed++;
      });

      const details = `Executed ${n} buys: <strong>${success} succeeded</strong>, <strong>${failed} failed</strong>`;
      popup('Bulk trade executed', details, 6000);

      // Stop after one bulk execution
      finishSmart();
      resolve();
    });
  });
}

// Removed ad-hoc checkTick since we stream now.

async function executeTrade(symbol, type, barrier, liveQuote) {
  const stake = stakeInput.value;
  // We delegate completely to buyContract.mjs which now uses the robust connection
  await buyContract(symbol, type, 1, stake, barrier, liveQuote, true);
}


function stopSmart() {
  finishSmart();
  popup("Stopped");
}

function finishSmart() {
  running = false;
  tradeLock = false;
  if (unsubscribeTicks) {
    unsubscribeTicks();
    unsubscribeTicks = null;
  }
}