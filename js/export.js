/**
 * GlobalFX Pro - Export Manager
 * Generates CSV and JSON downloads from the local transaction log.
 */

class ExportManager {
  /**
   * Escapes a value for CSV. Fields are quoted and embedded quotes doubled, per
   * RFC 4180, so a value containing a comma or quote cannot break the row.
   */
  static escapeCSV(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  /**
   * Triggers a browser download for generated file content.
   */
  static download(content, filename, mimeType) {
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.setAttribute("href", url);
      link.setAttribute("download", filename);
      link.style.visibility = "hidden";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Release the object URL once the download has been handed off
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { success: true };
    } catch (error) {
      console.error("Export failed:", error);
      return { success: false, message: "Export failed due to write permissions or browser blocks." };
    }
  }

  /**
   * Generates and triggers automatic download of conversion history in CSV format
   * @param {Array} history Array of conversion transaction objects
   */
  static exportToCSV(history) {
    if (!history || history.length === 0) {
      return { success: false, message: "No conversion history available to export." };
    }

    const headers = ["ID", "Timestamp", "From Currency", "To Currency", "Amount", "Exchange Rate", "Result Amount"];

    const rows = history.map(entry => [
      entry.id,
      new Date(entry.timestamp).toISOString(),
      entry.from,
      entry.to,
      entry.amount.toFixed(2),
      entry.rate.toFixed(6),
      entry.result.toFixed(2)
    ]);

    const csvContent = [
      headers.map(header => this.escapeCSV(header)).join(","),
      ...rows.map(row => row.map(value => this.escapeCSV(value)).join(","))
    ].join("\n");

    return this.download(
      csvContent,
      `GlobalFX_History_${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv;charset=utf-8;"
    );
  }

  /**
   * Exports the raw transaction log as JSON for machine-readable record keeping.
   */
  static exportToJSON(history) {
    if (!history || history.length === 0) {
      return { success: false, message: "No conversion history available to export." };
    }

    const payload = {
      application: "GlobalFX Pro",
      exportedAt: new Date().toISOString(),
      recordCount: history.length,
      conversions: history
    };

    return this.download(
      JSON.stringify(payload, null, 2),
      `GlobalFX_History_${new Date().toISOString().slice(0, 10)}.json`,
      "application/json;charset=utf-8;"
    );
  }
}
