/**
 * GlobalFX Pro - Chart Engine
 *
 * Owns every Chart.js instance. It renders whatever series it is handed and
 * never fetches or derives market data itself. When there is nothing real to
 * plot it draws an explicit state message instead of an empty or invented axis.
 *
 * Colours are read from the design tokens at render time, so the chart stays in
 * step with the theme without duplicating any palette values here.
 */

class ChartManager {
  static activeChart = null;

  /**
   * Destroys existing chart to prevent memory leaks and hover artifacts
   */
  static destroyActiveChart() {
    if (this.activeChart) {
      this.activeChart.destroy();
      this.activeChart = null;
    }
  }

  /**
   * Reads a design token so the chart palette has a single source of truth.
   * @param {string} name Custom property name, e.g. "--pos"
   */
  static token(name, fallback = "") {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
  }

  /**
   * Converts a hex token to rgba, used for the area gradient beneath the line.
   */
  static withAlpha(hex, alpha) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!match) return `rgba(76, 125, 240, ${alpha})`;

    const [r, g, b] = match.slice(1).map(part => parseInt(part, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Formats ISO observation dates for the x-axis at an appropriate granularity.
   */
  static formatLabels(dates, timeframe) {
    const longRange = timeframe === "90D" || timeframe === "6M" || timeframe === "1Y";

    return dates.map(iso => {
      const date = new Date(`${iso}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return iso;

      return longRange
        ? date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    });
  }

  /**
   * Finds (or lazily creates) the state overlay that sits alongside the canvas.
   */
  static getPlaceholder(canvasEl) {
    const wrapper = canvasEl.parentElement;
    if (!wrapper) return null;

    let placeholder = wrapper.querySelector(".chart-state");
    if (!placeholder) {
      placeholder = document.createElement("div");
      placeholder.className = "chart-state";
      placeholder.setAttribute("role", "status");
      wrapper.appendChild(placeholder);
    }
    return placeholder;
  }

  /**
   * Renders an explicit loading / unavailable / error state in place of a chart.
   *
   * @param {string} canvasId Target canvas element id
   * @param {string} state One of CurrencyAPI.STATE
   * @param {string} message Human-readable explanation
   */
  static renderState(canvasId, state, message) {
    this.destroyActiveChart();

    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) return;

    const placeholder = this.getPlaceholder(canvasEl);
    if (!placeholder) return;

    this.hideTooltip(canvasEl);
    canvasEl.style.visibility = "hidden";
    placeholder.innerHTML = "";

    if (state === CurrencyAPI.STATE.LOADING) {
      placeholder.appendChild(UIManager.el("span", "chart-state-spinner"));
    } else {
      const icon = UIManager.el("div", "chart-state-icon");
      icon.appendChild(UIManager.icon(state === CurrencyAPI.STATE.ERROR ? "offline" : "info"));
      placeholder.appendChild(icon);
    }

    placeholder.appendChild(UIManager.el("p", "chart-state-text", message));
    placeholder.hidden = false;
  }

  /**
   * Finds (or creates) the custom tooltip element inside the chart wrapper.
   */
  static getTooltip(canvasEl) {
    const wrapper = canvasEl.parentElement;
    if (!wrapper) return null;

    let tooltip = wrapper.querySelector(".chart-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "chart-tooltip";
      wrapper.appendChild(tooltip);
    }
    return tooltip;
  }

  static hideTooltip(canvasEl) {
    const wrapper = canvasEl.parentElement;
    const tooltip = wrapper?.querySelector(".chart-tooltip");
    if (tooltip) tooltip.style.opacity = 0;
  }

  /**
   * Chart.js external tooltip handler. Rendering the tooltip as DOM keeps it on
   * the same type scale and surface tokens as the rest of the interface, which
   * a canvas-drawn tooltip cannot do.
   */
  static externalTooltip(context, meta) {
    const { chart, tooltip } = context;
    const element = this.getTooltip(chart.canvas);
    if (!element) return;

    if (tooltip.opacity === 0) {
      element.style.opacity = 0;
      return;
    }

    const point = tooltip.dataPoints?.[0];
    if (!point) return;

    const iso = meta.dates[point.dataIndex];
    const date = new Date(`${iso}T00:00:00Z`);
    const dateLabel = Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(undefined, {
          weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
        });

    element.innerHTML = "";
    element.appendChild(UIManager.el("div", "chart-tooltip-date", dateLabel));
    element.appendChild(UIManager.el("div", "chart-tooltip-pair", meta.pairLabel));
    element.appendChild(UIManager.el("div", "chart-tooltip-value",
      point.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })));

    // Keep the tooltip inside the plot area rather than letting it clip
    const width = element.offsetWidth;
    const half = width / 2;
    const clampedX = Math.min(Math.max(tooltip.caretX, half + 4), chart.width - half - 4);

    element.style.opacity = 1;
    element.style.left = `${clampedX}px`;
    element.style.top = `${Math.max(tooltip.caretY - 12, 4)}px`;
  }

  /**
   * Initializes or updates the historical trends line chart from observed data.
   *
   * @param {string} canvasId DOM element ID for the target canvas
   * @param {Object} data { dates, values, percentChange, timeframe }
   * @param {boolean} isDarkMode Current UI theme state
   */
  static renderHistoricalChart(canvasId, data, isDarkMode) {
    this.destroyActiveChart();

    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) return;

    if (!data || !Array.isArray(data.values) || data.values.length < 2) {
      this.renderState(canvasId, CurrencyAPI.STATE.UNAVAILABLE, "Not enough observations to plot this timeframe.");
      return;
    }

    // Hide any previous state overlay and restore the canvas
    const placeholder = this.getPlaceholder(canvasEl);
    if (placeholder) placeholder.hidden = true;
    canvasEl.style.visibility = "visible";

    const ctx = canvasEl.getContext("2d");
    const labels = this.formatLabels(data.dates, data.timeframe);
    const pairLabel = data.pairLabel || "Exchange rate";

    // Palette comes from the design tokens so the chart follows the theme
    const isPositive = (data.percentChange ?? 0) >= 0;
    const lineColor = isPositive ? this.token("--pos", "#2DB87F") : this.token("--neg", "#E5565B");
    const gridColor = this.token("--border", "#212731");
    const textColor = this.token("--text-3", "#667085");

    const gradient = ctx.createLinearGradient(0, 0, 0, canvasEl.clientHeight || 320);
    gradient.addColorStop(0, this.withAlpha(lineColor, 0.20));
    gradient.addColorStop(1, this.withAlpha(lineColor, 0));

    const tooltipMeta = { dates: data.dates, pairLabel };

    const chartConfig = {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: pairLabel,
            data: data.values,
            borderColor: lineColor,
            borderWidth: 2,
            pointBackgroundColor: lineColor,
            pointBorderColor: this.token("--surface", "#111419"),
            pointBorderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHitRadius: 20,
            fill: true,
            backgroundColor: gradient,
            tension: 0.3,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,          // replaced by the DOM tooltip below
            external: (context) => this.externalTooltip(context, tooltipMeta)
          }
        },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: textColor,
              font: { family: "'Inter', sans-serif", size: 11 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6,
              padding: 8
            }
          },
          y: {
            position: "right",
            border: { display: false },
            grid: {
              color: gridColor,
              drawTicks: false
            },
            ticks: {
              color: textColor,
              font: { family: "'Inter', sans-serif", size: 11 },
              maxTicksLimit: 6,
              padding: 10,
              callback: (value) => value.toLocaleString(undefined, {
                minimumFractionDigits: 2, maximumFractionDigits: 4
              })
            }
          }
        },
        animation: prefersReducedMotion()
          ? false
          : { duration: 420, easing: "easeOutQuart" }
      }
    };

    this.activeChart = new Chart(ctx, chartConfig);
  }
}
