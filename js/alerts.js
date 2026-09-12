/**
 * GlobalFX Pro - Rate Alert Engine
 *
 * Domain logic for threshold alerts on live exchange rates. Owns the alert
 * schema, validation, persistence (via StorageManager) and — most importantly —
 * crossing detection.
 *
 * This module contains no DOM code and issues no network requests. It is handed
 * the same live rates the converter uses and returns which alerts fired.
 */

class AlertsManager {
  static CONDITIONS = { ABOVE: "above", BELOW: "below" };

  /** Upper bound on stored alerts, to keep evaluation and storage bounded. */
  static MAX_ALERTS = 50;

  // ==========================================================================
  // Persistence & validation
  // ==========================================================================

  /**
   * Loads alerts, discarding any record that does not match the schema.
   * LocalStorage is user-writable, so every field is re-checked on read.
   * @returns {Array<Object>} Valid alerts only
   */
  static getAlerts() {
    const stored = StorageManager.getAlerts();
    const valid = stored.filter(alert => this.isValidStoredAlert(alert));

    // Silently heal storage if malformed records were dropped
    if (valid.length !== stored.length) {
      console.warn(`[Alerts] Discarded ${stored.length - valid.length} malformed alert(s).`);
      StorageManager.saveAlerts(valid);
    }

    return valid;
  }

  /**
   * Structural check for a persisted alert.
   */
  static isValidStoredAlert(alert) {
    if (!alert || typeof alert !== "object") return false;
    if (typeof alert.id !== "string" || alert.id.length === 0) return false;
    if (!this.isKnownCurrency(alert.base) || !this.isKnownCurrency(alert.quote)) return false;
    if (alert.base === alert.quote) return false;
    if (alert.condition !== this.CONDITIONS.ABOVE && alert.condition !== this.CONDITIONS.BELOW) return false;
    if (!Number.isFinite(alert.target) || alert.target <= 0) return false;
    if (typeof alert.enabled !== "boolean") return false;
    // previousRate is either null or a usable number
    if (alert.previousRate !== null && !Number.isFinite(alert.previousRate)) return false;
    return true;
  }

  /**
   * A currency code is only accepted if the app actually knows it. This also
   * prevents arbitrary user text from reaching the DOM through an alert row.
   */
  static isKnownCurrency(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(CurrencyAPI.CURRENCY_DETAILS, code);
  }

  /**
   * Validates user input before an alert is created.
   * @returns {{valid: boolean, error: string|null, value: Object|null}}
   */
  static validateInput(base, quote, condition, target) {
    const normalizedBase = String(base || "").toUpperCase().trim();
    const normalizedQuote = String(quote || "").toUpperCase().trim();

    if (!this.isKnownCurrency(normalizedBase)) {
      return { valid: false, error: "Select a valid base currency.", value: null };
    }
    if (!this.isKnownCurrency(normalizedQuote)) {
      return { valid: false, error: "Select a valid quote currency.", value: null };
    }
    if (normalizedBase === normalizedQuote) {
      return { valid: false, error: "Base and quote currencies must be different.", value: null };
    }
    if (condition !== this.CONDITIONS.ABOVE && condition !== this.CONDITIONS.BELOW) {
      return { valid: false, error: "Choose whether to alert above or below the target.", value: null };
    }

    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget)) {
      return { valid: false, error: "Enter a numeric target rate.", value: null };
    }
    if (numericTarget <= 0) {
      return { valid: false, error: "Target rate must be greater than zero.", value: null };
    }

    return {
      valid: true,
      error: null,
      value: { base: normalizedBase, quote: normalizedQuote, condition, target: numericTarget }
    };
  }

  /**
   * Creates and persists an alert.
   *
   * A newly created alert is armed only if the threshold is NOT already
   * satisfied. Creating a "USD/INR above 84" alert while the rate is already
   * 84.5 must not fire immediately — the user asked to be told about a
   * crossing, and no crossing has happened.
   *
   * @returns {{success: boolean, error: string|null, alert: Object|null}}
   */
  static createAlert(base, quote, condition, target, currentRate = null) {
    const validation = this.validateInput(base, quote, condition, target);
    if (!validation.valid) {
      return { success: false, error: validation.error, alert: null };
    }

    const alerts = this.getAlerts();
    if (alerts.length >= this.MAX_ALERTS) {
      return { success: false, error: `Alert limit reached (${this.MAX_ALERTS}). Delete one first.`, alert: null };
    }

    const { base: b, quote: q, condition: c, target: t } = validation.value;

    const duplicate = alerts.some(a => a.base === b && a.quote === q && a.condition === c && a.target === t);
    if (duplicate) {
      return { success: false, error: "An identical alert already exists.", alert: null };
    }

    const rate = Number.isFinite(currentRate) && currentRate > 0 ? currentRate : null;

    const alert = {
      id: this.generateId(),
      base: b,
      quote: q,
      condition: c,
      target: t,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null,
      previousRate: rate,
      // Armed unless the condition is already true at creation time
      armed: rate === null ? true : !this.isConditionMet(c, rate, t),
      triggerCount: 0
    };

    alerts.push(alert);
    StorageManager.saveAlerts(alerts);
    return { success: true, error: null, alert };
  }

  static deleteAlert(id) {
    const alerts = this.getAlerts().filter(alert => alert.id !== id);
    StorageManager.saveAlerts(alerts);
    return alerts;
  }

  /**
   * Enables or disables an alert. Re-enabling resets the crossing baseline so a
   * stale previousRate from before the pause cannot fire a phantom crossing.
   */
  static setEnabled(id, enabled, currentRate = null) {
    const alerts = this.getAlerts();
    const alert = alerts.find(a => a.id === id);
    if (!alert) return alerts;

    alert.enabled = Boolean(enabled);

    if (alert.enabled) {
      const rate = Number.isFinite(currentRate) && currentRate > 0 ? currentRate : null;
      alert.previousRate = rate;
      alert.armed = rate === null ? true : !this.isConditionMet(alert.condition, rate, alert.target);
    }

    StorageManager.saveAlerts(alerts);
    return alerts;
  }

  static generateId() {
    return `alert_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  }

  // ==========================================================================
  // Evaluation
  // ==========================================================================

  /** Whether the threshold condition holds at a given rate. */
  static isConditionMet(condition, rate, target) {
    return condition === this.CONDITIONS.ABOVE ? rate > target : rate < target;
  }

  /**
   * Detects a threshold CROSSING between two consecutive observations.
   *
   *   above: previous <= target  AND  current > target
   *   below: previous >= target  AND  current < target
   *
   * Staying on the far side of the threshold is not a crossing, which is what
   * stops an alert from firing on every poll while the condition remains true.
   */
  static hasCrossed(condition, previousRate, currentRate, target) {
    if (!Number.isFinite(previousRate)) return false;

    return condition === this.CONDITIONS.ABOVE
      ? previousRate <= target && currentRate > target
      : previousRate >= target && currentRate < target;
  }

  /**
   * Evaluates every enabled alert against current rates and returns those that
   * fired on this tick.
   *
   * Lifecycle per alert:
   *   1. No baseline yet  -> record the rate, arm according to current side, never fire.
   *   2. Crossing + armed -> fire once, then disarm.
   *   3. Condition false  -> re-arm, making the alert eligible for a future crossing.
   *
   * Step 3 is what allows an alert to fire again later without spamming: the
   * rate must travel back across the threshold before it can trigger anew.
   *
   * @param {Object} rates Live rates map (USD based), as used by the converter
   * @returns {Array<{alert: Object, rate: number}>} Alerts that fired this tick
   */
  static evaluate(rates) {
    if (!rates || typeof rates !== "object") return [];

    const alerts = this.getAlerts();
    if (alerts.length === 0) return [];

    const triggered = [];
    let mutated = false;

    for (const alert of alerts) {
      if (!alert.enabled) continue;

      const currentRate = this.resolveRate(rates, alert.base, alert.quote);
      if (currentRate === null) continue; // No live rate for this pair right now

      const previousRate = alert.previousRate;

      if (!Number.isFinite(previousRate)) {
        // First observation: establish a baseline without firing
        alert.previousRate = currentRate;
        alert.armed = !this.isConditionMet(alert.condition, currentRate, alert.target);
        mutated = true;
        continue;
      }

      if (alert.armed && this.hasCrossed(alert.condition, previousRate, currentRate, alert.target)) {
        alert.armed = false;
        alert.lastTriggeredAt = new Date().toISOString();
        alert.triggerCount = (alert.triggerCount || 0) + 1;
        triggered.push({ alert: { ...alert }, rate: currentRate });
      } else if (!this.isConditionMet(alert.condition, currentRate, alert.target)) {
        // Rate returned to the other side of the threshold — eligible again
        if (!alert.armed) mutated = true;
        alert.armed = true;
      }

      if (alert.previousRate !== currentRate) mutated = true;
      alert.previousRate = currentRate;
    }

    if (mutated || triggered.length > 0) {
      StorageManager.saveAlerts(alerts);
    }

    return triggered;
  }

  /**
   * Derives a pair rate from the USD-based live rates map.
   * @returns {number|null} Rate, or null when either leg is missing
   */
  static resolveRate(rates, base, quote) {
    const baseRate = Number(rates[base]);
    const quoteRate = Number(rates[quote]);

    if (!Number.isFinite(baseRate) || !Number.isFinite(quoteRate) || baseRate <= 0) return null;

    const rate = quoteRate / baseRate;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  /**
   * Decimal places appropriate for displaying a rate, so notifications never
   * imply more precision than the value carries.
   */
  static precisionFor(rate) {
    if (rate >= 1000) return 2;
    if (rate >= 10) return 3;
    return 4;
  }

  /**
   * Builds notification copy for a fired alert.
   */
  static formatNotification(alert, rate) {
    const direction = alert.condition === this.CONDITIONS.ABOVE ? "above" : "below";
    const decimals = this.precisionFor(rate);

    return {
      title: `${alert.base}/${alert.quote} Alert`,
      body: `${alert.base}/${alert.quote} crossed ${direction} ${alert.target.toFixed(decimals)}.\n` +
            `Current rate: ${rate.toFixed(decimals)}`
    };
  }
}
