/**
 * GlobalFX Pro - Analytics Engine
 *
 * Derives every market metric from the single shared historical dataset
 * produced by CurrencyAPI. This module performs calculations only: it never
 * fetches, never touches the DOM, and never fabricates a value. Any metric that
 * cannot be computed from real observations is returned as unavailable.
 */

class AnalyticsManager {
  /**
   * Realized-volatility bands, in annualized percent, mapping to a 1-10 score.
   *
   * These are fixed, regime-independent thresholds anchored to long-run FX
   * behaviour — hard pegs sit near 0%, major pairs typically run 5-12%, and
   * stressed or crisis pairs exceed 20%. They are deliberately NOT fitted to
   * the currently loaded window, so a score means the same thing in a calm year
   * as in a turbulent one.
   */
  static VOLATILITY_BANDS = [2, 3.5, 5, 6.5, 8, 10, 12, 15, 20];

  /**
   * Currencies shown in the multi-currency comparison table.
   */
  static COMPARISON_CURRENCIES = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "INR", "SGD", "ZAR", "CNY"];

  /**
   * Compiles conversion history and favorite lists to calculate insights.
   *
   * These are user-level statistics computed from the local transaction log —
   * they describe the user's own activity, not the market.
   *
   * @param {Object} rates Live currency rates relative to USD
   * @param {Array} history List of conversion records from StorageManager
   * @param {Array} favorites List of favorited pairs from StorageManager
   * @param {Object} dataset Normalized historical dataset (for coverage reporting)
   * @returns {Object} Compiled statistical values for cards
   */
  static calculateAnalyticsSummary(rates, history, favorites, dataset) {
    const totalConversions = history.length;

    const pairFreq = {};
    const currencyFreq = {};
    let totalUsdValue = 0;
    let valuedConversions = 0;

    history.forEach(entry => {
      const pair = `${entry.from}/${entry.to}`;
      pairFreq[pair] = (pairFreq[pair] || 0) + 1;

      currencyFreq[entry.from] = (currencyFreq[entry.from] || 0) + 1;
      currencyFreq[entry.to] = (currencyFreq[entry.to] || 0) + 1;

      // Only average entries we can actually express in USD
      const fromRate = rates && rates[entry.from];
      if (Number.isFinite(fromRate) && fromRate > 0) {
        totalUsdValue += entry.amount / fromRate;
        valuedConversions++;
      }
    });

    const topKey = (freq) => {
      let best = "N/A";
      let bestCount = 0;
      for (const [key, count] of Object.entries(freq)) {
        if (count > bestCount) {
          bestCount = count;
          best = key;
        }
      }
      return best;
    };

    const averageAmountUsd = valuedConversions > 0 ? totalUsdValue / valuedConversions : 0;

    return {
      totalConversions,
      currenciesSupported: Object.keys(CurrencyAPI.CURRENCY_DETAILS).length,
      historicalCoverage: CurrencyAPI.getHistoricalCurrencies(dataset).length,
      mostActiveCurrency: topKey(currencyFreq),
      mostConvertedPair: topKey(pairFreq),
      favoritePair: favorites.length > 0 ? favorites[0] : "USD/EUR",
      averageConversionAmountUsd: averageAmountUsd,
      averageIsPartial: valuedConversions < totalConversions
    };
  }

  /**
   * Maps an annualized realized volatility to a 1-10 score plus display band.
   */
  static scoreVolatility(annualizedPct) {
    let score = 1;
    for (const threshold of this.VOLATILITY_BANDS) {
      if (annualizedPct >= threshold) score++;
    }
    score = Math.min(score, 10);

    let label = "Very Low";
    let colorClass = "vol-low";
    if (score >= 9) { label = "Very High"; colorClass = "vol-high"; }
    else if (score >= 7) { label = "High"; colorClass = "vol-high"; }
    else if (score >= 5) { label = "Moderate"; colorClass = "vol-medium"; }
    else if (score >= 3) { label = "Low"; colorClass = "vol-low"; }

    return { score, label, colorClass };
  }

  /**
   * Full volatility profile for a pair, computed from observed prices.
   *
   * Reports the one-year drift alongside the volatility on purpose: a managed
   * or crawling-peg currency can post very low day-to-day volatility while
   * moving a long way in one direction. Showing only the volatility score would
   * read as "safe" and materially mislead. Volatility is dispersion, not risk.
   *
   * @returns {{available: boolean, reason: string|null, ...}}
   */
  static getVolatilityProfile(dataset, from, to) {
    const series = CurrencyAPI.getPairSeries(dataset, from, to);
    if (!series.available) {
      return { available: false, reason: series.reason };
    }

    const volatility = CurrencyAPI.computeVolatility(series);
    if (!volatility.available) {
      return { available: false, reason: "insufficient-observations" };
    }

    const band = this.scoreVolatility(volatility.annualizedPct);
    const drift = CurrencyAPI.getPerformance(series, "1Y");

    return {
      available: true,
      reason: null,
      annualizedPct: volatility.annualizedPct,
      dailyPct: volatility.dailyPct,
      observations: volatility.observations,
      riskScore: band.score,
      volatility: band.label,
      colorClass: band.colorClass,
      drift1YPct: drift.available ? drift.percentChange : null,
      windowStart: series.dates[0],
      windowEnd: series.dates[series.dates.length - 1]
    };
  }

  /**
   * Performance of every historically-covered currency against a base,
   * computed from the shared dataset. Currencies without ECB coverage are
   * excluded rather than estimated.
   *
   * Direction matters here. The dataset series is quoted as "units of CODE per
   * 1 BASE", so a RISING series means CODE got weaker. A currency's own gain is
   * therefore measured on the inverted quote:
   *
   *   gain(CODE) = (rate_start / rate_end) - 1
   *
   * Using the raw series change would rank the worst performers as gainers.
   *
   * @returns {{available: boolean, gainers: Array, losers: Array, timeframe: string, asOf: string|null}}
   */
  static getTopMovers(dataset, baseCurrency, timeframe = "1D") {
    const currencies = CurrencyAPI.getHistoricalCurrencies(dataset);

    if (currencies.length === 0 || !CurrencyAPI.hasHistoryFor(dataset, baseCurrency)) {
      return { available: false, gainers: [], losers: [], timeframe, asOf: null };
    }

    const movers = [];
    let asOf = null;

    for (const code of currencies) {
      if (code === baseCurrency) continue;

      const series = CurrencyAPI.getPairSeries(dataset, baseCurrency, code);
      if (!series.available) continue;

      const performance = CurrencyAPI.getPerformance(series, timeframe);
      if (!performance.available || !performance.to) continue;

      asOf = performance.toDate;
      const details = CurrencyAPI.CURRENCY_DETAILS[code];

      movers.push({
        code,
        name: details?.name || code,
        flag: details?.flag || "un",
        // How much this currency gained against the base, on the inverted quote
        change: ((performance.from / performance.to) - 1) * 100,
        rate: performance.to
      });
    }

    if (movers.length === 0) {
      return { available: false, gainers: [], losers: [], timeframe, asOf: null };
    }

    movers.sort((a, b) => b.change - a.change);

    return {
      available: true,
      timeframe,
      asOf,
      gainers: movers.slice(0, 3),
      losers: movers.slice(-3).reverse()
    };
  }

  /**
   * Market-wide summary derived entirely from observed data.
   *
   * Note: this replaces the previous "strongest/weakest currency" comparison of
   * nominal rate levels, which measured denomination rather than strength — a
   * currency quoted in thousands per unit is not weak, merely differently
   * scaled. Strength here means realized performance over the window.
   */
  static getMarketOverview(dataset, baseCurrency) {
    const unavailable = {
      available: false,
      strongest: null, weakest: null, mostVolatile: null, steadiest: null
    };

    const currencies = CurrencyAPI.getHistoricalCurrencies(dataset);
    if (currencies.length === 0 || !CurrencyAPI.hasHistoryFor(dataset, baseCurrency)) {
      return unavailable;
    }

    const rows = [];
    for (const code of currencies) {
      if (code === baseCurrency) continue;

      const series = CurrencyAPI.getPairSeries(dataset, baseCurrency, code);
      if (!series.available) continue;

      const performance = CurrencyAPI.getPerformance(series, "1Y");
      const volatility = CurrencyAPI.computeVolatility(series);

      rows.push({
        code,
        name: CurrencyAPI.CURRENCY_DETAILS[code]?.name || code,
        // The currency's own gain against the base (inverted quote), so that
        // "strongest" means strongest, not "rate rose the most".
        change1Y: performance.available && performance.to
          ? ((performance.from / performance.to) - 1) * 100
          : null,
        volatility: volatility.available ? volatility.annualizedPct : null
      });
    }

    const withChange = rows.filter(row => row.change1Y !== null);
    const withVolatility = rows.filter(row => row.volatility !== null);

    if (withChange.length === 0 && withVolatility.length === 0) return unavailable;

    // change1Y is already the currency's own gain, so the strongest performer
    // is simply the largest value.
    const byChangeDesc = [...withChange].sort((a, b) => b.change1Y - a.change1Y);
    const byVolatility = [...withVolatility].sort((a, b) => a.volatility - b.volatility);

    return {
      available: true,
      base: baseCurrency,
      strongest: byChangeDesc[0] || null,
      weakest: byChangeDesc[byChangeDesc.length - 1] || null,
      steadiest: byVolatility[0] || null,
      mostVolatile: byVolatility[byVolatility.length - 1] || null
    };
  }

  /**
   * Rows for the multi-currency comparison table, all values observed.
   */
  static getComparisonRows(dataset, baseCurrency, liveRates) {
    return this.COMPARISON_CURRENCIES
      .filter(code => code !== baseCurrency)
      .map(code => {
        const series = CurrencyAPI.getPairSeries(dataset, baseCurrency, code);
        const oneDay = CurrencyAPI.getPerformance(series, "1D");
        const sevenDay = CurrencyAPI.getPerformance(series, "7D");

        // Prefer the live spot rate; fall back to the latest ECB close
        const baseRate = liveRates?.[baseCurrency];
        const targetRate = liveRates?.[code];
        const liveRate = Number.isFinite(baseRate) && Number.isFinite(targetRate) && baseRate > 0
          ? targetRate / baseRate
          : null;

        return {
          code,
          name: CurrencyAPI.CURRENCY_DETAILS[code]?.name || code,
          flag: CurrencyAPI.CURRENCY_DETAILS[code]?.flag || "un",
          symbol: CurrencyAPI.CURRENCY_DETAILS[code]?.symbol || "",
          rate: liveRate ?? (oneDay.available ? oneDay.to : null),
          rateIsLive: liveRate !== null,
          historyAvailable: series.available,
          change1D: oneDay.available ? oneDay.percentChange : null,
          change7D: sevenDay.available ? sevenDay.percentChange : null
        };
      });
  }

  /**
   * Ranked realized-volatility table for the currencies with the widest and
   * narrowest observed movement against the base. Replaces the previously
   * hardcoded "volatility guide" cards.
   */
  static getVolatilityLeaderboard(dataset, baseCurrency, limit = 3) {
    const currencies = CurrencyAPI.getHistoricalCurrencies(dataset);
    if (currencies.length === 0 || !CurrencyAPI.hasHistoryFor(dataset, baseCurrency)) return [];

    const rows = [];
    for (const code of currencies) {
      if (code === baseCurrency) continue;

      const profile = this.getVolatilityProfile(dataset, baseCurrency, code);
      if (!profile.available) continue;

      rows.push({
        pair: `${baseCurrency}/${code}`,
        name: CurrencyAPI.CURRENCY_DETAILS[code]?.name || code,
        annualizedPct: profile.annualizedPct,
        riskScore: profile.riskScore,
        volatility: profile.volatility,
        colorClass: profile.colorClass,
        drift1YPct: profile.drift1YPct
      });
    }

    rows.sort((a, b) => b.annualizedPct - a.annualizedPct);
    return rows.slice(0, limit);
  }
}
