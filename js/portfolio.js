/**
 * GlobalFX Pro - Portfolio Logic
 */

class PortfolioManager {
  static addHolding(currency, amount, purchaseRate) {
    const portfolio = StorageManager.getPortfolio();

    const existingHolding = portfolio.find(
      (h) => h.currency === currency.toUpperCase(),
    );

    if (existingHolding) {
      return {
        success: false,
        message: "Asset already exists.",
      };
    }

    portfolio.push({
      id: Date.now(),
      currency: currency.toUpperCase(),
      amount: parseFloat(amount),
      purchaseRate: parseFloat(purchaseRate),
      date: new Date().toISOString(),
    });

    StorageManager.savePortfolio(portfolio);
    return { success: true, message: "Holding added successfully." };
  }

  static updateHolding(id, updatedData) {
    let portfolio = StorageManager.getPortfolio();
    portfolio = portfolio.map((h) => {
      if (h.id === id) {
        return { ...h, ...updatedData };
      }
      return h;
    });
    StorageManager.savePortfolio(portfolio);
  }

  static deleteHolding(id) {
    let portfolio = StorageManager.getPortfolio();
    portfolio = portfolio.filter((h) => h.id !== id);
    StorageManager.savePortfolio(portfolio);
  }

  static getAnalytics(rates, baseCurrency = "USD") {
    const portfolio = StorageManager.getPortfolio();

    const totalHoldings = portfolio.length;

    let totalInvested = 0;
    let currentValue = 0;

    let bestPerformer = null;
    let bestROI = -Infinity;

    portfolio.forEach((h) => {
      // Amount invested
      const invested = h.amount / h.purchaseRate;
      totalInvested += invested;

      // Current value
      const rateBase = rates[baseCurrency] || 1;
      const rateTarget = rates[h.currency] || 1;
      const currentRate = rateTarget / rateBase;
      const current = h.amount / currentRate;

      currentValue += current;

      // Individual ROI
      const holdingROI = ((current - invested) / invested) * 100;

      if (holdingROI > bestROI) {
        bestROI = holdingROI;
        bestPerformer = h.currency;
      }
    });

    const roi =
      totalInvested > 0
        ? ((currentValue - totalInvested) / totalInvested) * 100
        : 0;

    return {
      totalInvested,
      currentValue,
      roi,
      totalHoldings,
      bestPerformer,
      bestROI,
    };
  }
}
