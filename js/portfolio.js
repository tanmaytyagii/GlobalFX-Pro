/**
 * GlobalFX Pro - Portfolio Logic
 *
 * Values manually-recorded currency holdings against current rates. All figures
 * are expressed in the caller's chosen base currency.
 */

class PortfolioManager {
  static addHolding(currency, amount, purchaseRate) {
    const portfolio = StorageManager.getPortfolio();
    portfolio.push({
      id: Date.now(),
      currency: String(currency).toUpperCase(),
      amount: parseFloat(amount),
      purchaseRate: parseFloat(purchaseRate),
      date: new Date().toISOString()
    });
    StorageManager.savePortfolio(portfolio);
  }

  static deleteHolding(id) {
    const portfolio = StorageManager.getPortfolio().filter(holding => holding.id !== id);
    StorageManager.savePortfolio(portfolio);
  }

  /**
   * Aggregate portfolio valuation.
   *
   * A holding is only counted when a live rate for its currency actually
   * exists. Previously a missing rate silently defaulted to 1.0, which valued
   * unknown currencies at parity and produced a plausible-looking but wrong
   * total; holdings that cannot be priced are now reported separately instead.
   *
   * @param {Object} rates Live rates map (USD based)
   * @param {string} baseCurrency Currency to express values in
   * @returns {{available: boolean, totalInvested: number, currentValue: number, roi: number, pricedCount: number, unpricedCount: number}}
   */
  static getAnalytics(rates, baseCurrency = "USD") {
    const portfolio = StorageManager.getPortfolio();
    const baseRate = Number(rates?.[baseCurrency]);

    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      return { available: false, totalInvested: 0, currentValue: 0, roi: 0, pricedCount: 0, unpricedCount: portfolio.length };
    }

    let totalInvested = 0;
    let currentValue = 0;
    let pricedCount = 0;
    let unpricedCount = 0;

    portfolio.forEach(holding => {
      const targetRate = Number(rates?.[holding.currency]);
      if (!Number.isFinite(targetRate) || targetRate <= 0) {
        unpricedCount++;
        return;
      }

      // Value in base currency when purchased, using the user-recorded rate
      totalInvested += holding.amount / holding.purchaseRate;
      // Value in base currency now
      currentValue += holding.amount / (targetRate / baseRate);
      pricedCount++;
    });

    const roi = totalInvested > 0 ? ((currentValue - totalInvested) / totalInvested) * 100 : 0;

    return {
      available: portfolio.length === 0 || pricedCount > 0,
      totalInvested,
      currentValue,
      roi,
      pricedCount,
      unpricedCount
    };
  }
}
