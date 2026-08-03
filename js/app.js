/**
 * GlobalFX Pro - Main App Orchestrator
 * Wires up modules, schedules network rate syncs, and binds system events.
 */

// Application State
const appState = {
  rates: {},
  fromCurrency: "USD",
  toCurrency: "EUR",
  activeTimeframe: "30D",
  isDarkMode: true,
  lastCalculatedAmount: 0.0,
};

// Global reference for statistics transitions
let prevStats = { totalConversions: 0, averageAmount: 0 };
let uiManager;
let editingHoldingId = null;

/**
 * Recalculates conversion estimate based on amount input
 */
function handleCalculation() {
  const fromAmountInput = document.getElementById("converter-amount-from");
  const toAmountInput = document.getElementById("converter-amount-to");
  if (!fromAmountInput || !toAmountInput) return;

  const amount = parseFloat(fromAmountInput.value);
  if (isNaN(amount) || amount <= 0) {
    toAmountInput.value = "";
    return;
  }

  const result = CurrencyConverter.convert(
    amount,
    appState.fromCurrency,
    appState.toCurrency,
    appState.rates,
  );
  toAmountInput.value = result.toFixed(2);
  appState.lastCalculatedAmount = result;
}

/**
 * Wires up details for charts rendering
 */
function drawChart() {
  const base = appState.fromCurrency;
  const target = appState.toCurrency;

  const rateBase = appState.rates[base] || 1;
  const rateTarget = appState.rates[target] || 1;
  const currentRate = rateTarget / rateBase;

  // Generate historical data
  const chartData = CurrencyAPI.generateHistoricalRates(
    base,
    target,
    appState.activeTimeframe,
    currentRate,
  );

  // Render Chart
  ChartManager.renderHistoricalChart(
    "fx-history-chart",
    chartData,
    appState.isDarkMode,
  );

  // Update visual text titles
  const chartTitle = document.getElementById("chart-currency-pair");
  if (chartTitle) chartTitle.textContent = `${base} / ${target} Trend`;

  const chartRateVal = document.getElementById("chart-rate-value");
  if (chartRateVal) {
    const targetSymbol = CurrencyAPI.CURRENCY_DETAILS[target]?.symbol || "";
    chartRateVal.textContent = `${targetSymbol}${currentRate.toFixed(4)}`;
  }

  const chartChangePct = document.getElementById("chart-change-percentage");
  if (chartChangePct) {
    const sign = chartData.percentChange >= 0 ? "+" : "";
    chartChangePct.textContent = `${sign}${chartData.percentChange.toFixed(2)}%`;
    chartChangePct.className =
      "chart-change-pct " +
      (chartData.percentChange >= 0 ? "trend-up" : "trend-down");
  }

  // Update timeframe trends
  const trends = CurrencyAPI.getExchangeRateTrends(base, target, currentRate);
  uiManager.renderTrendAnalysisPanel(trends, base, target);
}

/**
 * Updates full dashboard modules
 */
function refreshDashboard() {
  const history = StorageManager.getConversionHistory();
  const favorites = StorageManager.getFavoritePairs();

  // 1. Calculate and update dashboard summaries
  const stats = AnalyticsManager.calculateAnalyticsSummary(
    appState.rates,
    history,
    favorites,
  );
  uiManager.renderAnalyticsDashboard(stats, prevStats);

  // Cache stats for transition animations
  prevStats.totalConversions = stats.totalConversions;
  prevStats.averageAmount = stats.averageConversionAmountUsd;

  // 2. Render recent list
  uiManager.renderConversionHistory(history);

  // 3. Render cross comparison table
  uiManager.renderComparisonTable(appState.fromCurrency, appState.rates);

  // 4. Update live conversion display
  const base = appState.fromCurrency;
  const target = appState.toCurrency;
  const currentRate =
    (appState.rates[target] || 1) / (appState.rates[base] || 1);
  uiManager.updateConversionDisplay(currentRate, base, target);
  uiManager.updateVolatilityDisplay(base, target);

  // 5. Market Insights
  const marketOverview = AnalyticsManager.getMarketOverview(appState.rates);
  uiManager.renderMarketOverview(marketOverview);

  // 6. Update Portfolio if active
  if (typeof refreshPortfolio === "function") refreshPortfolio();
}

function editHolding(id) {
  const holding = StorageManager.getPortfolio().find((h) => h.id === id);

  if (!holding) return;

  editingHoldingId = id;

  document.getElementById("hold-currency").value = holding.currency;
  document.getElementById("hold-amount").value = holding.amount;
  document.getElementById("hold-rate").value = holding.purchaseRate;

  document.getElementById("add-holding-btn").textContent = "Update Asset";
}

/**
 * App initialization orchestrator
 */
async function initializeApplication() {
  // --- NEW PORTFOLIO BINDINGS ---
  window.refreshPortfolio = function () {
    const analytics = PortfolioManager.getAnalytics(
      appState.rates,
      appState.fromCurrency,
    );
    const valEl = document.getElementById("portfolio-total-value");
    const roiEl = document.getElementById("portfolio-total-roi");
    const holdingsEl = document.getElementById("portfolio-total-holdings");
    const bestPerformerEl = document.getElementById("portfolio-best-performer");

    if (valEl)
      valEl.textContent = `$${analytics.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (roiEl) {
      const roiSign = analytics.roi >= 0 ? "+" : "";
      roiEl.textContent = `${roiSign}${analytics.roi.toFixed(2)}%`;
    }

    if (holdingsEl) {
      holdingsEl.textContent = analytics.totalHoldings;
    }

    if (bestPerformerEl) {
      if (analytics.bestPerformer) {
        bestPerformerEl.textContent = `${analytics.bestPerformer} (${analytics.bestROI.toFixed(2)}%)`;
      } else {
        bestPerformerEl.textContent = "-";
      }
    }

    const tbody = document.getElementById("portfolio-table-body");
    if (tbody) {
      tbody.innerHTML = "";
      StorageManager.getPortfolio().forEach((h) => {
        // Calculate live individual metrics
        const rateBase = appState.rates[appState.fromCurrency] || 1;
        const rateTarget = appState.rates[h.currency] || 1;
        const liveRate = rateTarget / rateBase;

        const invested = h.amount / h.purchaseRate;
        const currentVal = h.amount / liveRate;
        const indvRoi = ((currentVal - invested) / invested) * 100;

        const roiColor =
          indvRoi >= 0 ? "var(--color-success)" : "var(--color-danger)";
        const roiSign = indvRoi >= 0 ? "+" : "";

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>
            <div style="display:flex; align-items:center; gap:12px;">
              <div style="width: 36px; height: 36px; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:0.85rem; color: var(--text-primary);">
                ${h.currency}
              </div>
              <span style="font-weight: 600; font-size: 1.05rem;">${h.currency}</span>
            </div>
          </td>
          <td style="font-family: var(--font-display); font-size: 1.05rem;">${h.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td style="color: var(--text-secondary);">${h.purchaseRate.toFixed(4)}</td>
          <td style="font-family: var(--font-display); font-weight: bold; font-size: 1.05rem;">$${currentVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td style="color: ${roiColor}; font-weight: bold; font-size: 1.05rem;">${roiSign}${indvRoi.toFixed(2)}%</td>
          <td style="text-align: right;">
          <div style="display: flex; justify-content: flex-end; align-items: center; gap: 8px;">
          <button
              onclick="editHolding(${h.id})"
              class="btn-secondary"
              style="margin-right:8px;"
          >
                  Edit
           </button>
            <button onclick="PortfolioManager.deleteHolding(${h.id}); refreshPortfolio();" class="btn-secondary" style="padding: 6px 14px; color: var(--color-danger); border-color: rgba(239, 68, 68, 0.15); background: rgba(239, 68, 68, 0.05);">
              Close
            </button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
  };

  const addHoldingBtn = document.getElementById("add-holding-btn");
  addHoldingBtn.addEventListener("click", () => {
    const cur = document
      .getElementById("hold-currency")
      .value.trim()
      .toUpperCase();

    const amt = parseFloat(document.getElementById("hold-amount").value);
    const rate = parseFloat(document.getElementById("hold-rate").value);

    // Validate currency
    if (!CurrencyAPI.CURRENCY_DETAILS[cur]) {
      uiManager.showToast("Please enter a valid currency code.", "warning");
      return;
    }

    // Validate amount
    if (isNaN(amt) || amt <= 0) {
      uiManager.showToast("Amount must be greater than 0.", "warning");
      return;
    }

    // Validate purchase rate
    if (isNaN(rate) || rate <= 0) {
      uiManager.showToast("Purchase rate must be greater than 0.", "warning");
      return;
    }

    if (editingHoldingId === null) {
      console.log("Adding new holding:");
      const result = PortfolioManager.addHolding(cur, amt, rate);

      if (!result.success) {
        uiManager.showToast(result.message, "warning");
        return;
      }

      uiManager.showToast("Holding added to portfolio!", "success");
    } else {
      PortfolioManager.updateHolding(editingHoldingId, {
        currency: cur,
        amount: amt,
        purchaseRate: rate,
      });

      uiManager.showToast("Holding updated successfully!", "success");

      editingHoldingId = null;
      document.getElementById("add-holding-btn").textContent =
        "Add Asset to Portfolio";
    }

    refreshPortfolio();

    document.getElementById("hold-currency").value = "";
    document.getElementById("hold-amount").value = "";
    document.getElementById("hold-rate").value = "";
  });

  // Bind inputs value changed
  const fromAmountInput = document.getElementById("converter-amount-from");
  if (fromAmountInput) {
    fromAmountInput.addEventListener("input", handleCalculation);
  }

  // Bind Chart Timeframes selector
  const timeframeButtons = document.querySelectorAll(".timeframe-btn");
  timeframeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      timeframeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      appState.activeTimeframe = btn.getAttribute("data-period");
      drawChart();
    });
  });

  // Create UI Controller Instance
  uiManager = new UIManager(appState, {
    onCurrencyChange: (type, code) => {
      handleCalculation();
      drawChart();
      // Render comparison table base update
      uiManager.renderComparisonTable(appState.fromCurrency, appState.rates);

      const currentRate =
        (appState.rates[appState.toCurrency] || 1) /
        (appState.rates[appState.fromCurrency] || 1);
      uiManager.updateConversionDisplay(
        currentRate,
        appState.fromCurrency,
        appState.toCurrency,
      );
      uiManager.updateVolatilityDisplay(
        appState.fromCurrency,
        appState.toCurrency,
      );

      // Update portfolio on base currency change
      refreshPortfolio();
    },

    onSwap: () => {
      handleCalculation();
      drawChart();
      uiManager.renderComparisonTable(appState.fromCurrency, appState.rates);

      const currentRate =
        (appState.rates[appState.toCurrency] || 1) /
        (appState.rates[appState.fromCurrency] || 1);
      uiManager.updateConversionDisplay(
        currentRate,
        appState.fromCurrency,
        appState.toCurrency,
      );
      uiManager.updateVolatilityDisplay(
        appState.fromCurrency,
        appState.toCurrency,
      );

      // Update portfolio on base currency change
      refreshPortfolio();
    },

    onThemeChange: (isDark) => {
      appState.isDarkMode = isDark;
      drawChart(); // Redraw chart grids
    },

    onConvertSubmit: () => {
      const amount = parseFloat(fromAmountInput.value);
      const toAmountInput = document.getElementById("converter-amount-to");

      if (isNaN(amount) || amount <= 0 || !toAmountInput.value) {
        uiManager.showToast(
          "Please enter a valid amount to convert",
          "warning",
        );
        return;
      }

      const result = parseFloat(toAmountInput.value);
      CurrencyConverter.commitTransaction(
        appState.fromCurrency,
        appState.toCurrency,
        amount,
        result,
        appState.rates,
      );

      refreshDashboard();
      uiManager.showToast(
        `Converted ${amount} ${appState.fromCurrency} to ${appState.toCurrency} successfully!`,
        "success",
      );
    },

    onExportCSV: () => {
      const history = StorageManager.getConversionHistory();
      const exportRes = ExportManager.exportToCSV(history);
      if (exportRes && !exportRes.success) {
        uiManager.showToast(exportRes.message, "warning");
      } else {
        uiManager.showToast("Conversion history exported to CSV", "success");
      }
    },

    onClearHistory: () => {
      StorageManager.clearConversionHistory();
      refreshDashboard();
      uiManager.showToast("Conversion history cleared", "success");
    },

    onFavoriteToggle: () => {
      const pair = `${appState.fromCurrency}/${appState.toCurrency}`;
      StorageManager.toggleFavoritePair(pair);

      refreshDashboard();
      drawChart();
      uiManager.showToast("Updated favorites configuration", "success");
    },

    onViewChange: (view) => {
      if (view === "dashboard" || view === "analytics") {
        // Redraw canvas with small timeout to allow window styles layout
        setTimeout(() => drawChart(), 50);
      }
    },
  });

  // Run UI setups
  uiManager.init();

  // Load live rate data from API
  try {
    appState.rates = await CurrencyAPI.fetchExchangeRates();

    // Set status
    const statusLabel = document.getElementById("connection-status");
    if (statusLabel) {
      statusLabel.textContent = "Live Market Rates Connected";
    }
  } catch (error) {
    console.error("Rates fetch error:", error);
    uiManager.showToast(
      "Network offline. Loaded offline rates fallback.",
      "warning",
    );
  }

  // Set default currency values
  uiManager.selectors.from.setValue(appState.fromCurrency);
  uiManager.selectors.to.setValue(appState.toCurrency);

  // Set initial calculation values
  if (fromAmountInput) {
    fromAmountInput.value = "1000";
    handleCalculation();
  }

  // Render lists and components
  const movers = CurrencyAPI.getTopMovers(appState.rates);
  uiManager.renderMovers(movers);
  refreshDashboard();
  drawChart();

  // Start rates pooling (sync rates every 5 minutes)
  setInterval(async () => {
    appState.rates = await CurrencyAPI.fetchExchangeRates();
    refreshDashboard();
  }, 300000);
}

// ---- Service Worker Registration (PWA) ------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        console.log("[PWA] Service Worker registered:", reg.scope);
      })
      .catch((err) => {
        console.warn("[PWA] Service Worker registration failed:", err);
      });
  });
}

// Fire launch on load
document.addEventListener("DOMContentLoaded", initializeApplication);
