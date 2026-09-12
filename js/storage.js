/**
 * GlobalFX Pro - Storage Engine
 * Manages secure storage operations inside the local browser sandbox.
 *
 * Every read is defensive: LocalStorage is user-writable and can be corrupted,
 * cleared, quota-limited or disabled entirely (private browsing). A malformed
 * record must degrade to a safe empty value, never throw into the app.
 */

class StorageManager {
  static HISTORY_KEY = "globalfx_conversions_history";
  static FAVORITES_KEY = "globalfx_favorites";
  static THEME_KEY = "globalfx_theme";
  static PORTFOLIO_KEY = "globalfx_portfolio";
  static ALERTS_KEY = "globalfx_rate_alerts";
  static HISTORICAL_CACHE_KEY = "globalfx_historical_dataset";
  static LIVE_RATES_CACHE_KEY = "globalfx_live_rates_cache";

  /**
   * Safely reads and parses a JSON value from LocalStorage.
   * @param {string} key Storage key
   * @param {*} fallback Value returned when missing, unreadable or malformed
   * @param {Function} [validate] Optional predicate the parsed value must satisfy
   * @returns {*} Parsed value or the fallback
   */
  static readJSON(key, fallback, validate = null) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (error) {
      // Storage disabled (private mode / blocked cookies)
      console.warn(`[Storage] Unable to read "${key}":`, error);
      return fallback;
    }

    if (raw === null || raw === undefined || raw === "") return fallback;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`[Storage] Corrupted JSON at "${key}", discarding.`, error);
      this.remove(key);
      return fallback;
    }

    if (validate && !validate(parsed)) {
      console.warn(`[Storage] Unexpected shape at "${key}", discarding.`);
      this.remove(key);
      return fallback;
    }

    return parsed;
  }

  /**
   * Safely serialises and writes a JSON value. Never throws on quota errors.
   * @returns {boolean} Whether the write succeeded
   */
  static writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`[Storage] Unable to write "${key}":`, error);
      return false;
    }
  }

  static remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn(`[Storage] Unable to remove "${key}":`, error);
    }
  }

  // --- Conversion history ---------------------------------------------------

  static getConversionHistory() {
    const history = this.readJSON(this.HISTORY_KEY, [], Array.isArray);
    // Drop individually malformed records rather than failing the whole log
    return history.filter(entry =>
      entry &&
      typeof entry === "object" &&
      typeof entry.from === "string" &&
      typeof entry.to === "string" &&
      Number.isFinite(Number(entry.amount)) &&
      Number.isFinite(Number(entry.result)) &&
      Number.isFinite(Number(entry.rate))
    );
  }

  static logConversion(entry) {
    const history = this.getConversionHistory();
    history.unshift(entry);
    if (history.length > 500) {
      history.pop();
    }
    this.writeJSON(this.HISTORY_KEY, history);
    return history;
  }

  static clearConversionHistory() {
    this.remove(this.HISTORY_KEY);
  }

  // --- Favourites -----------------------------------------------------------

  static getFavoritePairs() {
    const favorites = this.readJSON(this.FAVORITES_KEY, null, Array.isArray);
    if (!favorites) return ["USD/EUR", "EUR/GBP", "USD/INR", "GBP/JPY"];
    return favorites.filter(pair => typeof pair === "string" && pair.includes("/"));
  }

  static toggleFavoritePair(pair) {
    const favorites = this.getFavoritePairs();
    const index = favorites.indexOf(pair);
    if (index > -1) {
      favorites.splice(index, 1);
    } else {
      favorites.push(pair);
    }
    this.writeJSON(this.FAVORITES_KEY, favorites);
    return favorites;
  }

  // --- Theme ----------------------------------------------------------------

  static saveTheme(theme) {
    try {
      localStorage.setItem(this.THEME_KEY, theme);
    } catch (error) {
      console.warn("[Storage] Unable to persist theme:", error);
    }
  }

  static getTheme() {
    try {
      const theme = localStorage.getItem(this.THEME_KEY);
      return theme === "light" || theme === "dark" ? theme : "dark";
    } catch (error) {
      return "dark";
    }
  }

  // --- Portfolio ------------------------------------------------------------

  static getPortfolio() {
    const portfolio = this.readJSON(this.PORTFOLIO_KEY, [], Array.isArray);
    return portfolio.filter(holding =>
      holding &&
      typeof holding === "object" &&
      typeof holding.currency === "string" &&
      Number.isFinite(Number(holding.amount)) &&
      Number.isFinite(Number(holding.purchaseRate)) &&
      Number(holding.purchaseRate) > 0
    );
  }

  static savePortfolio(portfolio) {
    this.writeJSON(this.PORTFOLIO_KEY, portfolio);
  }

  // --- Rate alerts ----------------------------------------------------------

  /**
   * Returns stored alerts. Validation of individual records is owned by
   * AlertsManager, which understands the alert schema.
   */
  static getAlerts() {
    return this.readJSON(this.ALERTS_KEY, [], Array.isArray);
  }

  static saveAlerts(alerts) {
    return this.writeJSON(this.ALERTS_KEY, alerts);
  }

  // --- Market data caches ---------------------------------------------------

  /**
   * Cached historical dataset. Stored so the dashboard can present *real*
   * previously-retrieved observations when the network is unavailable,
   * instead of fabricating a fallback series.
   */
  static getCachedHistoricalDataset() {
    return this.readJSON(
      this.HISTORICAL_CACHE_KEY,
      null,
      (value) => value && typeof value === "object" && Array.isArray(value.dates) && value.rates
    );
  }

  static saveCachedHistoricalDataset(dataset) {
    return this.writeJSON(this.HISTORICAL_CACHE_KEY, dataset);
  }

  /**
   * Cached live rates — real values from a previous successful fetch.
   */
  static getCachedLiveRates() {
    return this.readJSON(
      this.LIVE_RATES_CACHE_KEY,
      null,
      (value) => value && typeof value === "object" && value.rates && typeof value.rates === "object"
    );
  }

  static saveCachedLiveRates(payload) {
    return this.writeJSON(this.LIVE_RATES_CACHE_KEY, payload);
  }
}
