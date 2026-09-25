/**
 * GlobalFX Pro - Main App Orchestrator
 *
 * Wires modules together, owns the application state, schedules data refreshes
 * and drives the alert engine. All market values flow from CurrencyAPI through
 * AnalyticsManager before reaching the UI — this file never computes a metric
 * or invents a value of its own.
 */

// Application State
const appState = {
  rates: {},
  rateMeta: { state: CurrencyAPI.STATE.LOADING, fetchedAt: null },
  dataset: null,
  fromCurrency: "USD",
  toCurrency: "EUR",
  activeTimeframe: "30D",
  isDarkMode: true,
  lastCalculatedAmount: 0.00
};

// Global reference for statistics transitions
let prevStats = { totalConversions: 0, averageAmount: 0 };
let uiManager;

/** How often live rates are re-polled while the app is open. */
const RATE_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Current spot rate for the selected pair, or null when unavailable.
 */
function currentPairRate() {
  return AlertsManager.resolveRate(appState.rates, appState.fromCurrency, appState.toCurrency);
}

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

  const result = CurrencyConverter.convert(amount, appState.fromCurrency, appState.toCurrency, appState.rates);
  toAmountInput.value = result > 0 ? result.toFixed(2) : "";
  appState.lastCalculatedAmount = result;
}

/**
 * Renders the historical chart and timeframe statistics for the selected pair.
 *
 * Every number here comes from the shared ECB dataset. If the pair has no
 * historical series the chart shows an explicit unavailable state rather than
 * an empty or placeholder plot.
 */

/**
 * Shows or clears the coverage note when sliceSeries could not fill the
 * selected timeframe. Names the range actually plotted.
 */
function updateChartCoverageNote(windowSeries) {
  const note = document.getElementById("chart-coverage-note");
  if (!note) return;

  if (windowSeries && windowSeries.partial && windowSeries.dates && windowSeries.dates.length >= 2) {
    const from = UIManager.formatISODate(windowSeries.dates[0]);
    const to = UIManager.formatISODate(windowSeries.dates[windowSeries.dates.length - 1]);
    note.textContent = `Insufficient historical observations for this window — showing ${from} to ${to}.`;
    note.hidden = false;
  } else {
    note.textContent = "";
    note.hidden = true;
  }
}

function drawChart() {
  const base = appState.fromCurrency;
  const target = appState.toCurrency;
  const pairLabel = `${base}/${target}`;

  const chartTitle = document.getElementById("chart-currency-pair");
  if (chartTitle) chartTitle.textContent = `${base} / ${target} Trend`;

  // Dataset still loading
  if (!appState.dataset) {
    ChartManager.renderState("fx-history-chart", CurrencyAPI.STATE.LOADING, "Loading ECB historical data…");
    setChartHeadline(null, null);
    updateChartCoverageNote(null);
    uiManager.renderTrendAnalysisPanel({}, base, target);
    return;
  }

  const series = CurrencyAPI.getPairSeries(appState.dataset, base, target);

  if (!series.available) {
    const message = series.reason === "same-currency"
      ? "Select two different currencies to see a trend."
      : appState.dataset.state === CurrencyAPI.STATE.ERROR
        ? "Historical data could not be loaded. Check your connection and try again."
        : `Historical data unavailable for ${pairLabel}. The ECB reference series does not cover this pair.`;

    ChartManager.renderState("fx-history-chart", appState.dataset.state, message);
    setChartHeadline(null, null);
    updateChartCoverageNote(null);
    uiManager.renderTrendAnalysisPanel({}, base, target);
    return;
  }

  const windowSeries = CurrencyAPI.sliceSeries(series, appState.activeTimeframe);
  const performance = CurrencyAPI.getPerformance(series, appState.activeTimeframe);
  updateChartCoverageNote(windowSeries);

  ChartManager.renderHistoricalChart("fx-history-chart", {
    dates: windowSeries.dates,
    values: windowSeries.values,
    percentChange: performance.available ? performance.percentChange : 0,
    timeframe: appState.activeTimeframe,
    pairLabel
  }, appState.isDarkMode);

  // Headline shows the latest observed close, and the change over the window
  setChartHeadline(series.values[series.values.length - 1], performance.available ? performance.percentChange : null);

  // Timeframe statistics, each computed independently from real observations
  const performances = {};
  for (const timeframe of ["1D", "7D", "30D", "1Y"]) {
    const result = CurrencyAPI.getPerformance(series, timeframe);
    performances[timeframe] = result.available ? result.percentChange : null;
  }
  uiManager.renderTrendAnalysisPanel(performances, base, target);
}

/**
 * Updates the rate + change figures above the chart.
 */
function setChartHeadline(rate, percentChange) {
  const rateEl = document.getElementById("chart-rate-value");
  if (rateEl) {
    rateEl.textContent = Number.isFinite(rate)
      ? `${CurrencyAPI.CURRENCY_DETAILS[appState.toCurrency]?.symbol || ""}${rate.toFixed(UIManager.precisionFor(rate))}`
      : "—";
  }

  const changeEl = document.getElementById("chart-change-percentage");
  if (changeEl) {
    if (!Number.isFinite(percentChange)) {
      changeEl.textContent = "—";
      changeEl.className = "chart-change-pct";
      return;
    }
    const sign = percentChange >= 0 ? "+" : "";
    changeEl.textContent = `${sign}${percentChange.toFixed(2)}%`;
    changeEl.className = "chart-change-pct " + (percentChange >= 0 ? "trend-up" : "trend-down");
  }
}

/**
 * Updates every dashboard module from current state.
 */
function refreshDashboard() {
  const history = StorageManager.getConversionHistory();
  const favorites = StorageManager.getFavoritePairs();

  // 1. User-level statistics from the local transaction log
  const stats = AnalyticsManager.calculateAnalyticsSummary(appState.rates, history, favorites, appState.dataset);
  uiManager.renderAnalyticsDashboard(stats, prevStats);

  prevStats.totalConversions = stats.totalConversions;
  prevStats.averageAmount = stats.averageConversionAmountUsd;

  // 2. Transaction log
  uiManager.renderConversionHistory(history);

  // 3. Live conversion summary
  uiManager.updateConversionDisplay(
    currentPairRate(), appState.fromCurrency, appState.toCurrency, appState.rateMeta
  );

  // 4. Market analytics, all derived from the shared historical dataset
  refreshMarketAnalytics();

  // 5. Portfolio valuation
  refreshPortfolio();

  // 6. Alerts reflect the latest rates
  refreshAlerts();
}

/**
 * Re-renders everything that depends on the historical dataset.
 */
function refreshMarketAnalytics() {
  const base = appState.fromCurrency;

  uiManager.updateVolatilityDisplay(
    AnalyticsManager.getVolatilityProfile(appState.dataset, base, appState.toCurrency),
    base, appState.toCurrency
  );

  uiManager.renderMovers(AnalyticsManager.getTopMovers(appState.dataset, base, "1D"));
  uiManager.renderVolatilityLeaderboard(AnalyticsManager.getVolatilityLeaderboard(appState.dataset, base, 3), base);
  uiManager.renderMarketOverview(AnalyticsManager.getMarketOverview(appState.dataset, base));
  uiManager.renderComparisonTable(AnalyticsManager.getComparisonRows(appState.dataset, base, appState.rates));
}

/**
 * Re-values portfolio holdings against current rates.
 *
 * Values are expressed in the selected base currency, so the displayed symbol
 * follows that currency rather than assuming US dollars.
 */
function refreshPortfolio() {
  const base = appState.fromCurrency;
  const symbol = CurrencyAPI.CURRENCY_DETAILS[base]?.symbol || "";
  const analytics = PortfolioManager.getAnalytics(appState.rates, base);

  const baseLabel = document.getElementById("portfolio-base-label");
  if (baseLabel) baseLabel.textContent = base;

  const valueEl = document.getElementById("portfolio-total-value");
  const roiEl = document.getElementById("portfolio-total-roi");

  if (valueEl) {
    valueEl.textContent = analytics.available
      ? `${symbol}${analytics.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—";
  }

  if (roiEl) {
    if (analytics.available) {
      const sign = analytics.roi >= 0 ? "+" : "";
      roiEl.textContent = `${sign}${analytics.roi.toFixed(2)}%`;
      roiEl.style.color = analytics.roi >= 0 ? "var(--color-success)" : "var(--color-danger)";
    } else {
      roiEl.textContent = "—";
      roiEl.style.color = "var(--text-muted)";
    }
  }

  renderPortfolioTable(base, symbol);
}

/**
 * Renders the holdings table. Built with safe DOM APIs so stored holding data
 * cannot be interpreted as markup.
 */
function renderPortfolioTable(base, symbol) {
  const tbody = document.getElementById("portfolio-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";
  const holdings = StorageManager.getPortfolio();

  if (holdings.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(UIManager.emptyState(
      "portfolio",
      "No holdings recorded",
      "Add a currency holding below to track its value against live rates."
    ));
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  holdings.forEach(holding => {
    const liveRate = AlertsManager.resolveRate(appState.rates, base, holding.currency);
    const invested = holding.amount / holding.purchaseRate;
    const currentValue = liveRate === null ? null : holding.amount / liveRate;
    const roi = currentValue === null ? null : ((currentValue - invested) / invested) * 100;

    const row = document.createElement("tr");

    // Asset
    const assetCell = document.createElement("td");
    const assetWrap = UIManager.el("div", "portfolio-asset-cell");
    assetWrap.appendChild(UIManager.el("div", "portfolio-asset-badge", holding.currency));
    assetWrap.appendChild(UIManager.el("span", "portfolio-asset-code", holding.currency));
    assetCell.appendChild(assetWrap);
    row.appendChild(assetCell);

    // Amount held
    row.appendChild(UIManager.el("td", "table-rate-cell num-col",
      holding.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })));

    // Purchase rate
    row.appendChild(UIManager.el("td", "table-muted-cell num-col", holding.purchaseRate.toFixed(4)));

    // Live value in the base currency
    row.appendChild(UIManager.el("td", "table-rate-cell num-col",
      currentValue === null
        ? "—"
        : `${symbol}${currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));

    // ROI
    const roiCell = UIManager.el("td", "num-col", roi === null ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`);
    roiCell.style.fontWeight = "bold";
    roiCell.style.color = roi === null
      ? "var(--text-muted)"
      : roi >= 0 ? "var(--color-success)" : "var(--color-danger)";
    row.appendChild(roiCell);

    // Manage
    const actionCell = UIManager.el("td", "portfolio-action-cell num-col");
    const closeBtn = UIManager.el("button", "btn btn-danger btn-sm btn-icon");
    closeBtn.type = "button";
    closeBtn.appendChild(UIManager.icon("trash"));
    closeBtn.setAttribute("aria-label", `Remove ${holding.currency} holding`);
    closeBtn.addEventListener("click", () => {
      PortfolioManager.deleteHolding(holding.id);
      refreshPortfolio();
      uiManager.showToast("Holding removed from portfolio", "success");
    });
    actionCell.appendChild(closeBtn);
    row.appendChild(actionCell);

    tbody.appendChild(row);
  });
}

// ============================================================================
// Rate alerts
// ============================================================================

function refreshAlerts() {
  uiManager.renderAlerts(AlertsManager.getAlerts(), appState.rates);
  uiManager.updateAlertRatePreview();
}

/**
 * Reports what the browser will actually allow, without overpromising.
 */
function notificationStatus() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission; // "granted" | "denied" | "default"
}

/**
 * Requests notification permission. Only ever called from a deliberate user
 * action, and never re-prompted once the user has decided.
 */
async function requestNotificationPermission() {
  if (typeof Notification === "undefined") {
    uiManager.showToast("This browser does not support notifications.", "warning");
    return;
  }

  if (Notification.permission !== "default") {
    uiManager.renderNotificationStatus(Notification.permission);
    return;
  }

  try {
    const result = await Notification.requestPermission();
    uiManager.renderNotificationStatus(result);
    uiManager.showToast(
      result === "granted" ? "Notifications enabled for rate alerts." : "Notifications were not enabled.",
      result === "granted" ? "success" : "warning"
    );
  } catch (error) {
    console.warn("[Alerts] Notification permission request failed:", error);
    uiManager.renderNotificationStatus(notificationStatus());
  }
}

/**
 * Delivers a fired alert. Always surfaces in-app; additionally raises a system
 * notification when permission has been granted.
 */
async function deliverAlert(alert, rate) {
  const { title, body } = AlertsManager.formatNotification(alert, rate);

  uiManager.showToast(body.split("\n").join(" "), "warning", title);

  if (notificationStatus() !== "granted") return;

  try {
    // Prefer the service worker registration: on Android, page-constructed
    // Notifications are not permitted.
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(title, {
          body,
          tag: `globalfx-${alert.id}`,
          badge: "https://flagcdn.com/w40/eu.png",
          icon: `https://flagcdn.com/w80/${CurrencyAPI.CURRENCY_DETAILS[alert.quote]?.flag || "un"}.png`,
          data: { pair: `${alert.base}/${alert.quote}` }
        });
        return;
      }
    }
    new Notification(title, { body, tag: `globalfx-${alert.id}` });
  } catch (error) {
    console.warn("[Alerts] Unable to display notification:", error);
  }
}

/**
 * Evaluates all alerts against the current rates and delivers any that fired.
 */
async function evaluateAlerts() {
  if (!appState.rates || Object.keys(appState.rates).length === 0) return;

  const triggered = AlertsManager.evaluate(appState.rates);
  for (const { alert, rate } of triggered) {
    await deliverAlert(alert, rate);
  }

  if (triggered.length > 0) refreshAlerts();
}

// ============================================================================
// Data loading
// ============================================================================

/**
 * Refreshes live rates and re-renders everything that depends on them.
 */
async function syncLiveRates() {
  const result = await CurrencyAPI.fetchExchangeRates();

  appState.rates = result.rates;
  appState.rateMeta = { state: result.state, fetchedAt: result.fetchedAt };

  uiManager.updateDataSourceIndicator(appState.rateMeta, appState.dataset || { state: CurrencyAPI.STATE.LOADING, dates: [] });

  if (result.state === CurrencyAPI.STATE.ERROR) {
    uiManager.showToast("Live rates unavailable and no cached rates stored.", "error");
  }

  handleCalculation();
  refreshDashboard();
  await evaluateAlerts();
}

/**
 * Loads the shared historical dataset and re-renders all market analytics.
 */
async function loadHistoricalData() {
  ChartManager.renderState("fx-history-chart", CurrencyAPI.STATE.LOADING, "Loading ECB historical data…");
  uiManager.renderMarketSkeletons();

  const dataset = await CurrencyAPI.fetchHistoricalDataset();
  appState.dataset = dataset;

  uiManager.clearMarketSkeletons();
  uiManager.updateDataSourceIndicator(appState.rateMeta, dataset);

  if (dataset.state === CurrencyAPI.STATE.ERROR) {
    uiManager.showToast("Historical market data unavailable. Analytics are disabled.", "warning");
  } else if (dataset.state === CurrencyAPI.STATE.CACHED) {
    uiManager.showToast("Offline — showing previously downloaded ECB data.", "warning");
  }

  refreshMarketAnalytics();
  drawChart();

  const stats = AnalyticsManager.calculateAnalyticsSummary(
    appState.rates, StorageManager.getConversionHistory(), StorageManager.getFavoritePairs(), dataset
  );
  uiManager.renderAnalyticsDashboard(stats, prevStats);
}

/**
 * Re-renders the parts of the UI that depend on the selected pair.
 */
function onPairChanged() {
  handleCalculation();
  drawChart();
  refreshMarketAnalytics();
  uiManager.updateConversionDisplay(
    currentPairRate(), appState.fromCurrency, appState.toCurrency, appState.rateMeta
  );
  refreshPortfolio();
}

// ============================================================================
// Bootstrap
// ============================================================================

async function initializeApplication() {
  // --- Portfolio form -------------------------------------------------------
  const addHoldingBtn = document.getElementById("add-holding-btn");
  if (addHoldingBtn) {
    addHoldingBtn.addEventListener("click", () => {
      const currencyInput = document.getElementById("hold-currency");
      const amountInput = document.getElementById("hold-amount");
      const rateInput = document.getElementById("hold-rate");

      const currency = String(currencyInput?.value || "").toUpperCase().trim();
      const amount = Number(amountInput?.value);
      const rate = Number(rateInput?.value);

      if (!Object.prototype.hasOwnProperty.call(CurrencyAPI.CURRENCY_DETAILS, currency)) {
        uiManager.showToast("Enter a supported currency code (for example EUR).", "warning");
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        uiManager.showToast("Enter an amount greater than zero.", "warning");
        return;
      }
      if (!Number.isFinite(rate) || rate <= 0) {
        uiManager.showToast("Enter a purchase rate greater than zero.", "warning");
        return;
      }

      PortfolioManager.addHolding(currency, amount, rate);
      uiManager.showToast("Holding added to portfolio", "success");
      refreshPortfolio();

      currencyInput.value = "";
      amountInput.value = "";
      rateInput.value = "";
    });
  }

  // --- Converter input ------------------------------------------------------
  const fromAmountInput = document.getElementById("converter-amount-from");
  if (fromAmountInput) {
    fromAmountInput.addEventListener("input", handleCalculation);
  }

  // --- Chart timeframes -----------------------------------------------------
  const timeframeButtons = document.querySelectorAll(".timeframe-btn");
  timeframeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      timeframeButtons.forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      appState.activeTimeframe = btn.getAttribute("data-period");
      drawChart();
    });
  });

  // --- UI controller --------------------------------------------------------
  uiManager = new UIManager(appState, {
    onCurrencyChange: () => onPairChanged(),
    onSwap: () => onPairChanged(),

    onThemeChange: (isDark) => {
      appState.isDarkMode = isDark;
      drawChart(); // Redraw chart grids for the new theme
    },

    onConvertSubmit: () => {
      const amount = parseFloat(fromAmountInput.value);
      const toAmountInput = document.getElementById("converter-amount-to");

      if (isNaN(amount) || amount <= 0 || !toAmountInput.value) {
        uiManager.showToast("Please enter a valid amount to convert", "warning");
        return;
      }

      CurrencyConverter.commitTransaction(
        appState.fromCurrency, appState.toCurrency, amount, parseFloat(toAmountInput.value), appState.rates
      );

      refreshDashboard();
      uiManager.showToast(
        `Converted ${amount} ${appState.fromCurrency} to ${appState.toCurrency} successfully!`, "success"
      );
    },

    onExportCSV: () => {
      const result = ExportManager.exportToCSV(StorageManager.getConversionHistory());
      uiManager.showToast(
        result.success ? "Conversion history exported to CSV" : result.message,
        result.success ? "success" : "warning"
      );
    },

    onExportJSON: () => {
      const result = ExportManager.exportToJSON(StorageManager.getConversionHistory());
      uiManager.showToast(
        result.success ? "Conversion history exported to JSON" : result.message,
        result.success ? "success" : "warning"
      );
    },

    onClearHistory: () => {
      StorageManager.clearConversionHistory();
      refreshDashboard();
      uiManager.showToast("Conversion history cleared", "success");
    },

    onFavoriteToggle: () => {
      StorageManager.toggleFavoritePair(`${appState.fromCurrency}/${appState.toCurrency}`);
      refreshDashboard();
      drawChart();
      uiManager.showToast("Updated favorites configuration", "success");
    },

    onViewChange: (view) => {
      if (view === "dashboard") {
        // Canvas needs a layout pass before it can size correctly
        setTimeout(() => drawChart(), 60);
      }
      if (view === "alerts") refreshAlerts();

      // Views are swapped by CSS, so move the reading position to the top
      window.scrollTo({ top: 0, behavior: "auto" });
    },

    onCreateAlert: ({ base, quote, condition, target }) => {
      const rate = AlertsManager.resolveRate(appState.rates, base, quote);
      const result = AlertsManager.createAlert(base, quote, condition, target, rate);

      if (!result.success) {
        uiManager.showAlertFormMessage(result.error, "error");
        return;
      }

      uiManager.showAlertFormMessage("");
      uiManager.closeAlertModal();
      refreshAlerts();

      const { base: b, quote: q, condition: c, target: t } = result.alert;
      uiManager.showToast(
        `You will be notified when ${b}/${q} crosses ${c} ${t.toFixed(AlertsManager.precisionFor(t))}.`,
        "success",
        "Alert created"
      );

      // Ask for notification permission only after deliberate intent
      if (notificationStatus() === "default") requestNotificationPermission();
    },

    onDeleteAlert: (id) => {
      AlertsManager.deleteAlert(id);
      refreshAlerts();
      uiManager.showToast("Alert deleted", "success");
    },

    onToggleAlert: (id, enabled) => {
      const alert = AlertsManager.getAlerts().find(a => a.id === id);
      const rate = alert ? AlertsManager.resolveRate(appState.rates, alert.base, alert.quote) : null;
      AlertsManager.setEnabled(id, enabled, rate);
      refreshAlerts();
      uiManager.showToast(enabled ? "Alert resumed" : "Alert paused", "success");
    },

    onRequestNotifications: () => requestNotificationPermission()
  });

  uiManager.init();
  uiManager.renderNotificationStatus(notificationStatus());

  // Restore the selected pair in the converter controls
  uiManager.selectors.from?.setValue(appState.fromCurrency);
  uiManager.selectors.to?.setValue(appState.toCurrency);

  if (fromAmountInput) fromAmountInput.value = "1000";

  // Live rates first: the converter is the primary interaction and depends on
  // them. Historical analytics load in parallel and fill in when ready.
  await syncLiveRates();
  await loadHistoricalData();

  // Re-poll live rates while the app is open
  setInterval(syncLiveRates, RATE_POLL_INTERVAL_MS);

  // Re-check when the user returns to the tab, so a rate that moved while the
  // app was hidden is picked up promptly.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncLiveRates();
  });
}

// ---- Service Worker Registration (PWA) ------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      console.log('[PWA] Service Worker registered:', reg.scope);
    }).catch((err) => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  });
}

// Fire launch on load
document.addEventListener("DOMContentLoaded", initializeApplication);
