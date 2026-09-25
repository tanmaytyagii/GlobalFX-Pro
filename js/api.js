/**
 * GlobalFX Pro - API & Market Data Engine
 *
 * Owns ALL external communication and turns provider payloads into one stable
 * internal representation. No other module may know that Frankfurter or
 * open.er-api exist, or what shape they return.
 *
 * Two independent feeds:
 *   Live spot rates  -> open.er-api.com   (updated continuously, USD based)
 *   Historical series -> api.frankfurter.dev (ECB reference rates, EUR based)
 *
 * Nothing in this file simulates, interpolates or invents market data. When a
 * value is not available it is reported as unavailable.
 */

class CurrencyAPI {
  /**
   * Data provenance states. Every consumer of market data must be able to tell
   * these apart — they are never silently mixed.
   */
  static STATE = {
    LOADING: "loading",
    LIVE: "live",             // Fetched from the provider just now
    CACHED: "cached",         // Real data from an earlier fetch, served offline
    UNAVAILABLE: "unavailable", // Provider has no data for this currency/pair
    ERROR: "error"            // Network/provider failure and no cache to fall back on
  };

  // Supported currency data with country mappings for flags and full names
  static CURRENCY_DETAILS = {
    USD: { name: "US Dollar", flag: "us", symbol: "$", country: "United States" },
    EUR: { name: "Euro", flag: "eu", symbol: "€", country: "European Union" },
    GBP: { name: "British Pound", flag: "gb", symbol: "£", country: "United Kingdom" },
    JPY: { name: "Japanese Yen", flag: "jp", symbol: "¥", country: "Japan" },
    AUD: { name: "Australian Dollar", flag: "au", symbol: "A$", country: "Australia" },
    CAD: { name: "Canadian Dollar", flag: "ca", symbol: "C$", country: "Canada" },
    CHF: { name: "Swiss Franc", flag: "ch", symbol: "CHF", country: "Switzerland" },
    CNY: { name: "Chinese Yuan", flag: "cn", symbol: "¥", country: "China" },
    HKD: { name: "Hong Kong Dollar", flag: "hk", symbol: "HK$", country: "Hong Kong" },
    NZD: { name: "New Zealand Dollar", flag: "nz", symbol: "NZ$", country: "New Zealand" },
    SEK: { name: "Swedish Krona", flag: "se", symbol: "kr", country: "Sweden" },
    KRW: { name: "South Korean Won", flag: "kr", symbol: "₩", country: "South Korea" },
    SGD: { name: "Singapore Dollar", flag: "sg", symbol: "S$", country: "Singapore" },
    NOK: { name: "Norwegian Krone", flag: "no", symbol: "kr", country: "Norway" },
    MXN: { name: "Mexican Peso", flag: "mx", symbol: "$", country: "Mexico" },
    INR: { name: "Indian Rupee", flag: "in", symbol: "₹", country: "India" },
    RUB: { name: "Russian Ruble", flag: "ru", symbol: "₽", country: "Russia" },
    ZAR: { name: "South African Rand", flag: "za", symbol: "R", country: "South Africa" },
    TRY: { name: "Turkish Lira", flag: "tr", symbol: "₺", country: "Turkey" },
    BRL: { name: "Brazilian Real", flag: "br", symbol: "R$", country: "Brazil" },
    TWD: { name: "New Taiwan Dollar", flag: "tw", symbol: "NT$", country: "Taiwan" },
    DKK: { name: "Danish Krone", flag: "dk", symbol: "kr", country: "Denmark" },
    PLN: { name: "Polish Zloty", flag: "pl", symbol: "zł", country: "Poland" },
    THB: { name: "Thai Baht", flag: "th", symbol: "฿", country: "Thailand" },
    IDR: { name: "Indonesian Rupiah", flag: "id", symbol: "Rp", country: "Indonesia" },
    HUF: { name: "Hungarian Forint", flag: "hu", symbol: "Ft", country: "Hungary" },
    CZK: { name: "Czech Koruna", flag: "cz", symbol: "Kč", country: "Czech Republic" },
    ILS: { name: "Israeli New Shekel", flag: "il", symbol: "₪", country: "Israel" },
    CLP: { name: "Chilean Peso", flag: "cl", symbol: "$", country: "Chile" },
    PHP: { name: "Philippine Peso", flag: "ph", symbol: "₱", country: "Philippines" },
    AED: { name: "UAE Dirham", flag: "ae", symbol: "د.إ", country: "United Arab Emirates" },
    COP: { name: "Colombian Peso", flag: "co", symbol: "$", country: "Colombia" },
    SAR: { name: "Saudi Riyal", flag: "sa", symbol: "ر.س", country: "Saudi Arabia" },
    MYR: { name: "Malaysian Ringgit", flag: "my", symbol: "RM", country: "Malaysia" },
    RON: { name: "Romanian Leu", flag: "ro", symbol: "lei", country: "Romania" },
    ARS: { name: "Argentine Peso", flag: "ar", symbol: "$", country: "Argentina" },
    EGP: { name: "Egyptian Pound", flag: "eg", symbol: "E£", country: "Egypt" },
    VND: { name: "Vietnamese Dong", flag: "vn", symbol: "₫", country: "Vietnam" },
    UAH: { name: "Ukrainian Hryvnia", flag: "ua", symbol: "₴", country: "Ukraine" },
    KWD: { name: "Kuwaiti Dinar", flag: "kw", symbol: "د.ك", country: "Kuwait" },
    QAR: { name: "Qatari Riyal", flag: "qa", symbol: "ر.ق", country: "Qatar" },
    BGN: { name: "Bulgarian Lev", flag: "bg", symbol: "лв", country: "Bulgaria" },
    ISK: { name: "Icelandic Krona", flag: "is", symbol: "kr", country: "Iceland" },
  };

  static LIVE_URL = "https://open.er-api.com/v6/latest/USD";
  static HISTORY_URL = "https://api.frankfurter.dev/v1";

  /** Live spot rates go stale quickly; historical observations do not. */
  static LIVE_TTL_MS = 5 * 60 * 1000;        // 5 minutes
  static HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (ECB publishes once per business day)

  /** Calendar days of history requested — enough to cover a 1Y window plus non-trading days. */
  static HISTORY_LOOKBACK_DAYS = 400;

  /**
   * Market-day convention used to annualise daily volatility. ECB publishes on
   * TARGET business days; 252 is the standard convention for annualising daily
   * financial returns.
   */
  static TRADING_DAYS_PER_YEAR = 252;

  /** A currency must be quoted on at least this share of observations to be usable. */
  static MIN_COVERAGE_RATIO = 0.9;

  /** Timeframe -> calendar-day lookback. "1D" means "previous observation". */
  static TIMEFRAMES = {
    "1D": 1,
    "7D": 7,
    "30D": 30,
    "90D": 90,
    "6M": 182,
    "1Y": 365
  };

  static ratesCache = { data: null, timestamp: 0 };
  static historyCache = { data: null, timestamp: 0 };
  static historyInFlight = null;

  // ==========================================================================
  // Live spot rates
  // ==========================================================================

  /**
   * Fetches live spot rates (USD base).
   *
   * On failure this falls back ONLY to real rates previously retrieved and
   * cached. It never substitutes hardcoded or generated numbers — an empty
   * result with an ERROR state is the correct answer when nothing real exists.
   *
   * @returns {Promise<{rates: Object, state: string, fetchedAt: number|null}>}
   */
  static async fetchExchangeRates() {
    const now = Date.now();

    if (this.ratesCache.data && now - this.ratesCache.timestamp < this.LIVE_TTL_MS) {
      return { rates: this.ratesCache.data, state: this.STATE.LIVE, fetchedAt: this.ratesCache.timestamp };
    }

    try {
      const response = await fetch(this.LIVE_URL);
      if (!response.ok) throw new Error(`Live rates HTTP ${response.status}`);

      const payload = await response.json();
      const rates = this.normalizeLiveRates(payload);
      if (!rates) throw new Error("Unrecognised live rates payload");

      this.ratesCache = { data: rates, timestamp: now };
      StorageManager.saveCachedLiveRates({ rates, fetchedAt: now });
      return { rates, state: this.STATE.LIVE, fetchedAt: now };

    } catch (error) {
      console.warn("[API] Live rates unavailable:", error);

      const cached = StorageManager.getCachedLiveRates();
      if (cached && cached.rates && Object.keys(cached.rates).length > 0) {
        this.ratesCache = { data: cached.rates, timestamp: cached.fetchedAt || 0 };
        return { rates: cached.rates, state: this.STATE.CACHED, fetchedAt: cached.fetchedAt || null };
      }

      // Nothing real to show. Do not invent rates.
      return { rates: {}, state: this.STATE.ERROR, fetchedAt: null };
    }
  }

  /**
   * Validates and normalises a live-rates payload into a plain code->number map.
   * Defensive against provider shape changes and non-finite values.
   */
  static normalizeLiveRates(payload) {
    if (!payload || typeof payload !== "object") return null;
    const source = payload.rates || payload.conversion_rates;
    if (!source || typeof source !== "object") return null;

    const rates = {};
    for (const [code, value] of Object.entries(source)) {
      const numeric = Number(value);
      if (typeof code === "string" && code.length === 3 && Number.isFinite(numeric) && numeric > 0) {
        rates[code] = numeric;
      }
    }
    rates.USD = 1; // Base is implicit in the provider response
    return Object.keys(rates).length > 1 ? rates : null;
  }

  // ==========================================================================
  // Historical market data (ECB via Frankfurter)
  // ==========================================================================

  /**
   * Fetches the full historical dataset in ONE range request and normalises it.
   *
   * A single EUR-based dataset serves every consumer — charts, volatility,
   * trends and movers — because any pair A/B can be derived as
   * EUR->B divided by EUR->A. There is deliberately no per-currency request.
   *
   * @param {boolean} [force] Bypass the in-memory TTL
   * @returns {Promise<Object>} Normalized dataset (see normalizeHistoricalPayload)
   */
  static async fetchHistoricalDataset(force = false) {
    const now = Date.now();

    if (!force && this.historyCache.data && now - this.historyCache.timestamp < this.HISTORY_TTL_MS) {
      return this.historyCache.data;
    }

    // Collapse concurrent callers onto a single in-flight request
    if (this.historyInFlight) return this.historyInFlight;

    this.historyInFlight = (async () => {
      const end = new Date();
      const start = new Date(end.getTime() - this.HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const url = `${this.HISTORY_URL}/${this.toISODate(start)}..${this.toISODate(end)}?base=EUR`;

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Historical HTTP ${response.status}`);

        const payload = await response.json();
        const dataset = this.normalizeHistoricalPayload(payload);
        if (!dataset || dataset.dates.length === 0) throw new Error("Empty historical dataset");

        dataset.state = this.STATE.LIVE;
        dataset.fetchedAt = now;

        this.historyCache = { data: dataset, timestamp: now };
        StorageManager.saveCachedHistoricalDataset(dataset);
        return dataset;

      } catch (error) {
        console.warn("[API] Historical dataset unavailable:", error);

        const cached = StorageManager.getCachedHistoricalDataset();
        if (cached && Array.isArray(cached.dates) && cached.dates.length > 0) {
          const dataset = { ...cached, state: this.STATE.CACHED };
          this.historyCache = { data: dataset, timestamp: now };
          return dataset;
        }

        // No real history available. The UI must show an unavailable state.
        return {
          base: "EUR",
          dates: [],
          rates: {},
          currencies: [],
          state: this.STATE.ERROR,
          fetchedAt: null
        };
      } finally {
        this.historyInFlight = null;
      }
    })();

    return this.historyInFlight;
  }

  /**
   * Converts a Frankfurter range response into the internal dataset shape.
   *
   * Internal representation (provider-agnostic):
   *   {
   *     base: "EUR",
   *     dates: ["2024-09-12", ...],            // ascending, unique
   *     rates: { USD: [1.10, ...], ... },      // index-aligned with `dates`, null where unquoted
   *     currencies: ["AUD", ..., "ZAR"]        // codes meeting the coverage threshold
   *   }
   *
   * Handles: unordered keys, duplicate dates, missing currencies on a given
   * date, non-numeric values, and currencies that appear only intermittently.
   */
  static normalizeHistoricalPayload(payload) {
    if (!payload || typeof payload !== "object" || !payload.rates || typeof payload.rates !== "object") {
      return null;
    }

    const base = typeof payload.base === "string" ? payload.base : "EUR";

    // Ascending, de-duplicated ISO dates (ISO-8601 sorts correctly as text)
    const dates = Object.keys(payload.rates)
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort();

    if (dates.length === 0) return null;

    // Collect every currency the provider quoted at any point in the range
    const codes = new Set([base]);
    for (const date of dates) {
      const row = payload.rates[date];
      if (row && typeof row === "object") {
        for (const code of Object.keys(row)) codes.add(code);
      }
    }

    const rates = {};
    const coverage = {};

    for (const code of codes) {
      const series = new Array(dates.length).fill(null);
      let observed = 0;

      for (let i = 0; i < dates.length; i++) {
        const row = payload.rates[dates[i]];
        if (!row || typeof row !== "object") continue;

        // The base currency is implicit in the response and always 1
        const value = code === base ? 1 : Number(row[code]);
        if (Number.isFinite(value) && value > 0) {
          series[i] = value;
          observed++;
        }
      }

      rates[code] = series;
      coverage[code] = observed / dates.length;
    }

    // Only currencies quoted consistently enough to support analytics
    const currencies = Object.keys(rates)
      .filter(code => coverage[code] >= this.MIN_COVERAGE_RATIO)
      .sort();

    return { base, dates, rates, currencies, coverage };
  }

  /**
   * Whether the historical provider covers a currency.
   */
  static hasHistoryFor(dataset, code) {
    return Boolean(dataset && Array.isArray(dataset.currencies) && dataset.currencies.includes(code));
  }

  /**
   * Lists currencies with historical coverage, newest dataset wins.
   * @returns {string[]}
   */
  static getHistoricalCurrencies(dataset) {
    return dataset && Array.isArray(dataset.currencies) ? dataset.currencies : [];
  }

  /**
   * Derives a real observed series for an arbitrary pair from the shared dataset.
   *
   *   rate(FROM -> TO)[t] = base->TO[t] / base->FROM[t]
   *
   * Observations where either leg is unquoted are skipped, so the returned
   * series contains only dates where both currencies were actually published.
   *
   * @returns {{available: boolean, reason: string|null, dates: string[], values: number[]}}
   */
  static getPairSeries(dataset, from, to) {
    const empty = (reason) => ({ available: false, reason, dates: [], values: [] });

    if (!dataset || !Array.isArray(dataset.dates) || dataset.dates.length === 0) {
      return empty("no-dataset");
    }

    const missing = [from, to].filter(code => !this.hasHistoryFor(dataset, code));
    if (missing.length > 0) {
      return empty(`unsupported:${missing.join(",")}`);
    }

    if (from === to) return empty("same-currency");

    const fromSeries = dataset.rates[from];
    const toSeries = dataset.rates[to];
    const dates = [];
    const values = [];

    for (let i = 0; i < dataset.dates.length; i++) {
      const fromRate = fromSeries[i];
      const toRate = toSeries[i];
      if (fromRate === null || toRate === null || !fromRate) continue;

      dates.push(dataset.dates[i]);
      values.push(toRate / fromRate);
    }

    if (values.length < 2) return empty("insufficient-observations");

    return { available: true, reason: null, dates, values };
  }

  /**
   * Restricts a series to a timeframe window, measured in calendar days back
   * from the most recent observation. Weekends and holidays simply have no
   * observations — the window is never padded.
   */
  static sliceSeries(series, timeframe) {
    if (!series.available) return series;

    const lookbackDays = this.TIMEFRAMES[timeframe];
    if (!lookbackDays) return series;

    const lastDate = new Date(`${series.dates[series.dates.length - 1]}T00:00:00Z`);
    const cutoff = new Date(lastDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const cutoffISO = this.toISODate(cutoff);

    let startIndex = series.dates.findIndex(date => date >= cutoffISO);
    if (startIndex === -1) startIndex = series.dates.length - 1;

    // Always keep at least two points so a change can be expressed
    if (series.dates.length - startIndex < 2) {
      startIndex = Math.max(0, series.dates.length - 2);
    }

    return {
      available: true,
      reason: null,
      dates: series.dates.slice(startIndex),
      values: series.values.slice(startIndex),
      // True when the series begins after the requested cutoff, so the window
      // could not be filled. A missing weekend/holiday day is not partial.
      partial: series.dates[0] > cutoffISO
    };
  }

  /**
   * Percentage change over a timeframe, computed from real observations.
   *
   * "1D" compares the two most recent observations (ECB publishes once per
   * business day, so this is a session-over-session change, not intraday).
   * Longer windows anchor on the last observation at or before the target
   * calendar date, because the exact date may fall on a weekend or holiday.
   *
   * @returns {{available: boolean, percentChange: number|null, from: number|null, to: number|null, fromDate: string|null, toDate: string|null}}
   */
  static getPerformance(series, timeframe) {
    const unavailable = {
      available: false, percentChange: null,
      from: null, to: null, fromDate: null, toDate: null
    };

    if (!series.available || series.values.length < 2) return unavailable;

    const lastIndex = series.values.length - 1;
    const endValue = series.values[lastIndex];
    let startIndex;

    if (timeframe === "1D") {
      startIndex = lastIndex - 1;
    } else {
      const lookbackDays = this.TIMEFRAMES[timeframe];
      if (!lookbackDays) return unavailable;

      const lastDate = new Date(`${series.dates[lastIndex]}T00:00:00Z`);
      const targetISO = this.toISODate(new Date(lastDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000));

      // Last observation at or before the target date
      startIndex = -1;
      for (let i = lastIndex; i >= 0; i--) {
        if (series.dates[i] <= targetISO) { startIndex = i; break; }
      }

      // Range does not extend that far back — the window is incomplete
      if (startIndex === -1) return unavailable;
    }

    if (startIndex < 0) return unavailable;

    const startValue = series.values[startIndex];
    if (!Number.isFinite(startValue) || startValue === 0) return unavailable;

    return {
      available: true,
      percentChange: ((endValue - startValue) / startValue) * 100,
      from: startValue,
      to: endValue,
      fromDate: series.dates[startIndex],
      toDate: series.dates[lastIndex]
    };
  }

  /**
   * Realised (historical) volatility from observed prices.
   *
   *   rₜ  = ln(Pₜ / Pₜ₋₁)                 daily logarithmic return
   *   σ_d = sample standard deviation of rₜ
   *   σ_a = σ_d × √252                    annualised, standard market convention
   *
   * This measures observed price dispersion only. It is NOT a measure of
   * sovereign, geopolitical, liquidity, default or capital-control risk, and a
   * managed currency can show low realised volatility while carrying a large
   * directional drift.
   *
   * @returns {{available: boolean, annualizedPct: number|null, dailyPct: number|null, observations: number}}
   */
  static computeVolatility(series) {
    if (!series.available || series.values.length < 3) {
      return { available: false, annualizedPct: null, dailyPct: null, observations: 0 };
    }

    const logReturns = [];
    for (let i = 1; i < series.values.length; i++) {
      const previous = series.values[i - 1];
      const current = series.values[i];
      if (previous > 0 && current > 0) {
        logReturns.push(Math.log(current / previous));
      }
    }

    if (logReturns.length < 2) {
      return { available: false, annualizedPct: null, dailyPct: null, observations: logReturns.length };
    }

    const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
    // Sample variance (n-1): these observations are a sample, not the population
    const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1);
    const dailyStdDev = Math.sqrt(variance);

    return {
      available: true,
      dailyPct: dailyStdDev * 100,
      annualizedPct: dailyStdDev * Math.sqrt(this.TRADING_DAYS_PER_YEAR) * 100,
      observations: logReturns.length
    };
  }

  /** Formats a Date as an ISO yyyy-mm-dd string in UTC. */
  static toISODate(date) {
    return date.toISOString().slice(0, 10);
  }
}
