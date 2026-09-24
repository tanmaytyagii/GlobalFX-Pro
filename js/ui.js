/**
 * GlobalFX Pro - UI Manager
 *
 * Renders views, manages selectors and theming, and translates market data into
 * DOM. It performs no calculations and no network calls: it displays exactly
 * what the analytics layer reports, including explicit "unavailable" states.
 */

class UIManager {
  constructor(appState, callbacks = {}) {
    this.state = appState;
    this.callbacks = callbacks;
    this.selectors = {};
  }

  /**
   * Initializes all interface controls and binds base event listeners
   */
  init() {
    this.setupTheme();
    this.setupNavigation();
    this.setupSearchableSelectors();
    this.setupEventListeners();
    this.setupRipples();
  }

  /**
   * Sets up theme based on storage settings
   */
  setupTheme() {
    const isLight = StorageManager.getTheme() === "light";
    document.body.classList.toggle("light-theme", isLight);
    this.state.isDarkMode = !isLight;
    this.syncThemeButton();
  }

  /**
   * The toggle contains both a sun and a moon icon; CSS reveals the correct one
   * from the theme class. Only the accessible label changes here.
   */
  syncThemeButton() {
    const themeBtn = document.getElementById("theme-toggle-trigger");
    if (!themeBtn) return;

    const next = this.state.isDarkMode ? "light" : "dark";
    themeBtn.setAttribute("aria-label", `Switch to ${next} theme`);
    themeBtn.setAttribute("title", `Switch to ${next} theme`);
  }

  /**
   * Toggles theme and updates charts & storage
   */
  toggleTheme() {
    this.state.isDarkMode = !this.state.isDarkMode;

    // Suspend transitions across the swap so no var()-driven property is left
    // holding the previous theme's computed colour.
    document.body.classList.add("theme-switching");
    document.body.classList.toggle("light-theme", !this.state.isDarkMode);
    const releaseTransitions = () => document.body.classList.remove("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(releaseTransitions));
    // Fallback: rAF can be throttled in background tabs, and the guard must
    // never be left latched on.
    setTimeout(releaseTransitions, 120);
    StorageManager.saveTheme(this.state.isDarkMode ? "dark" : "light");
    this.syncThemeButton();

    if (this.callbacks.onThemeChange) {
      this.callbacks.onThemeChange(this.state.isDarkMode);
    }
  }

  /**
   * Manages layout view switches and navigation tab active classes
   */
  setupNavigation() {
    const navTabs = document.querySelectorAll(".nav-tab");
    const viewSections = document.querySelectorAll(".view-section");

    navTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        const targetView = tab.getAttribute("data-view");
        
        navTabs.forEach(t => {
          t.classList.remove("active");
          t.removeAttribute("aria-current");
        });
        viewSections.forEach(s => s.classList.remove("active"));

        tab.classList.add("active");
        tab.setAttribute("aria-current", "page");
        const targetSection = document.getElementById(`${targetView}-section`);
        if (targetSection) {
          targetSection.classList.add("active");
          targetSection.classList.add("fade-in");
          // Clean up animation class
          setTimeout(() => targetSection.classList.remove("fade-in"), 400);
        }
        
        if (this.callbacks.onViewChange) {
          this.callbacks.onViewChange(targetView);
        }
      });
    });
  }

  /**
   * Builds and activates the custom searchable selectors
   */
  setupSearchableSelectors() {
    this.selectors.from = this.createSearchableSelector(
      "from-currency-selector",
      this.state.fromCurrency,
      (code) => {
        this.state.fromCurrency = code;
        if (this.callbacks.onCurrencyChange) {
          this.callbacks.onCurrencyChange("from", code);
        }
      }
    );

    this.selectors.to = this.createSearchableSelector(
      "to-currency-selector",
      this.state.toCurrency,
      (code) => {
        this.state.toCurrency = code;
        if (this.callbacks.onCurrencyChange) {
          this.callbacks.onCurrencyChange("to", code);
        }
      }
    );

    // Rate alert pair selectors reuse the same searchable component
    this.selectors.alertBase = this.createSearchableSelector(
      "alert-base-selector",
      this.state.fromCurrency,
      () => this.updateAlertRatePreview()
    );

    this.selectors.alertQuote = this.createSearchableSelector(
      "alert-quote-selector",
      this.state.toCurrency,
      () => this.updateAlertRatePreview()
    );
  }

  /**
   * Paints a selector trigger for a currency code.
   *
   * Only the flag and code are shown. The full name would truncate inside a
   * compact control, and it is already listed in the dropdown.
   */
  static paintSelectTrigger(trigger, code) {
    const details = CurrencyAPI.CURRENCY_DETAILS[code];
    trigger.innerHTML = "";

    const flag = document.createElement("img");
    flag.className = "select-trigger-flag";
    flag.src = `https://flagcdn.com/w40/${details?.flag || "un"}.png`;
    flag.alt = "";
    trigger.appendChild(flag);

    trigger.appendChild(UIManager.el("span", "select-trigger-text", code));
    trigger.appendChild(UIManager.el("span", "select-trigger-arrow"));
    trigger.setAttribute("aria-label", `${code} — ${details?.name || code}`);
  }

  /**
   * Dynamic factory method to build a custom searchable select dropdown
   */
  createSearchableSelector(containerId, defaultVal, onChangeCallback) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    container.innerHTML = "";
    container.className = "custom-select-container";

    // Create trigger button
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    UIManager.paintSelectTrigger(trigger, defaultVal);
    container.appendChild(trigger);

    // Create dropdown panel
    const dropdown = document.createElement("div");
    dropdown.className = "custom-select-dropdown";

    const searchContainer = document.createElement("div");
    searchContainer.className = "custom-select-search-container";
    
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "custom-select-search-input";
    searchInput.placeholder = "Search by code, name, country…";
    searchInput.setAttribute("aria-label", "Search currencies");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.setAttribute("spellcheck", "false");
    searchContainer.appendChild(searchInput);
    dropdown.appendChild(searchContainer);

    // Options list
    const optionsList = document.createElement("ul");
    optionsList.className = "custom-select-options";
    optionsList.setAttribute("role", "listbox");
    dropdown.appendChild(optionsList);
    container.appendChild(dropdown);

    let selectedValue = defaultVal;
    let highlightedIndex = -1;
    let visibleOptions = [];

    // Render option items
    const renderOptions = (filterText = "") => {
      optionsList.innerHTML = "";
      visibleOptions = [];
      const query = filterText.toLowerCase().trim();

      Object.entries(CurrencyAPI.CURRENCY_DETAILS).forEach(([code, details]) => {
        const name = details.name.toLowerCase();
        const country = (details.country || "").toLowerCase();
        const codeLower = code.toLowerCase();

        // Search code, full currency name, or country name
        if (query === "" || codeLower.includes(query) || name.includes(query) || country.includes(query)) {
          const li = document.createElement("li");
          li.className = "custom-select-option";
          li.setAttribute("role", "option");
          li.setAttribute("data-value", code);
          
          if (code === selectedValue) {
            li.classList.add("selected");
            li.setAttribute("aria-selected", "true");
          }

          li.innerHTML = `
            <img class="custom-option-flag" src="https://flagcdn.com/w40/${details.flag}.png" alt="${code}">
            <span class="custom-option-code">${code}</span>
            <span class="custom-option-name">${details.name} (${details.country || ""})</span>
          `;
          
          optionsList.appendChild(li);
          visibleOptions.push(li);
        }
      });

      if (visibleOptions.length === 0) {
        const li = document.createElement("li");
        li.className = "custom-select-option disabled";
        li.style.color = "var(--text-muted)";
        li.style.cursor = "default";
        li.textContent = "No matches found";
        optionsList.appendChild(li);
      }
      
      highlightedIndex = -1;
    };

    renderOptions();

    // Toggle dropdown visibility
    const openDropdown = () => {
      // Close other dropdowns first
      document.querySelectorAll(".custom-select-dropdown").forEach(d => {
        if (d !== dropdown) d.classList.remove("show");
      });
      document.querySelectorAll(".custom-select-trigger").forEach(t => {
        if (t !== trigger) t.classList.remove("active");
      });

      dropdown.classList.add("show");
      trigger.classList.add("active");
      trigger.setAttribute("aria-expanded", "true");
      searchInput.value = "";
      renderOptions();
      setTimeout(() => searchInput.focus(), 50);
    };

    const closeDropdown = () => {
      dropdown.classList.remove("show");
      trigger.classList.remove("active");
      trigger.setAttribute("aria-expanded", "false");
    };

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains("show");
      if (isOpen) closeDropdown();
      else openDropdown();
    });

    // Dynamic filtering with debounce
    let searchTimeout;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        renderOptions(searchInput.value);
      }, 100);
    });

    searchInput.addEventListener("click", (e) => {
      e.stopPropagation(); // Avoid closing dropdown when typing in input
    });

    // Handle Option Selection
    optionsList.addEventListener("click", (e) => {
      const option = e.target.closest(".custom-select-option");
      if (!option || option.classList.contains("disabled")) return;

      const value = option.getAttribute("data-value");
      selectedValue = value;
      
      UIManager.paintSelectTrigger(trigger, value);

      closeDropdown();
      onChangeCallback(value);
    });

    // Keyboard navigation handlers
    container.addEventListener("keydown", (e) => {
      const isOpen = dropdown.classList.contains("show");
      
      if (e.key === "Escape") {
        closeDropdown();
        trigger.focus();
        e.preventDefault();
      }

      if (!isOpen) {
        if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
          openDropdown();
          e.preventDefault();
        }
        return;
      }

      // Keyboard navigation while list is open
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightedIndex = (highlightedIndex + 1) % visibleOptions.length;
        this.updateHighlightedOption(visibleOptions, highlightedIndex);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightedIndex = (highlightedIndex - 1 + visibleOptions.length) % visibleOptions.length;
        this.updateHighlightedOption(visibleOptions, highlightedIndex);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlightedIndex > -1 && visibleOptions[highlightedIndex]) {
          visibleOptions[highlightedIndex].click();
        } else if (visibleOptions.length > 0) {
          visibleOptions[0].click(); // Select first item if none highlighted
        }
      }
    });

    // Close on click outside
    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) {
        closeDropdown();
      }
    });

    return {
      setValue: (code) => {
        selectedValue = code;
        UIManager.paintSelectTrigger(trigger, code);
      },
      getValue: () => selectedValue
    };
  }

  /**
   * Helper to update visual highlighting during keyboard navigation
   */
  updateHighlightedOption(options, index) {
    options.forEach(opt => opt.classList.remove("highlighted"));
    const activeOpt = options[index];
    if (activeOpt) {
      activeOpt.classList.add("highlighted");
      activeOpt.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * Setup UI action triggers
   */
  setupEventListeners() {
    // Theme toggle bind
    const themeBtn = document.getElementById("theme-toggle-trigger");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => this.toggleTheme());
    }

    // Swapping trigger
    const swapBtn = document.getElementById("swap-currencies-btn");
    if (swapBtn) {
      swapBtn.addEventListener("click", () => {
        const fromVal = this.selectors.from.getValue();
        const toVal = this.selectors.to.getValue();
        
        this.selectors.from.setValue(toVal);
        this.selectors.to.setValue(fromVal);
        
        this.state.fromCurrency = toVal;
        this.state.toCurrency = fromVal;

        if (this.callbacks.onSwap) {
          this.callbacks.onSwap();
        }
      });
    }

    // Convert trigger button
    const convertBtn = document.getElementById("convert-btn-trigger");
    if (convertBtn) {
      convertBtn.addEventListener("click", () => {
        if (this.callbacks.onConvertSubmit) {
          this.callbacks.onConvertSubmit();
        }
      });
    }

    // CSV export triggers. Both the logs view and the portfolio view expose an
    // export control, so every id present in the markup is bound here.
    ["csv-export-btn-logs", "export-csv-btn", "csv-export-btn"].forEach(id => {
      const button = document.getElementById(id);
      if (button) {
        button.addEventListener("click", () => {
          if (this.callbacks.onExportCSV) {
            this.callbacks.onExportCSV();
          }
        });
      }
    });

    // JSON export trigger
    const jsonExportBtn = document.getElementById("export-json-btn");
    if (jsonExportBtn) {
      jsonExportBtn.addEventListener("click", () => {
        if (this.callbacks.onExportJSON) {
          this.callbacks.onExportJSON();
        }
      });
    }

    // Clear history trigger
    const clearHistoryBtn = document.getElementById("clear-history-btn");
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to clear your local conversion log? This will reset all analytics charts.")) {
          if (this.callbacks.onClearHistory) {
            this.callbacks.onClearHistory();
          }
        }
      });
    }

    // Favorites pair trigger
    const favoriteBtn = document.getElementById("favorite-pair-trigger");
    if (favoriteBtn) {
      favoriteBtn.addEventListener("click", () => {
        if (this.callbacks.onFavoriteToggle) {
          this.callbacks.onFavoriteToggle();
        }
      });
    }

    this.setupAlertControls();
  }

  /**
   * Binds the rate alert creation form, its modal, and the live rate preview.
   */
  setupAlertControls() {
    const form = document.getElementById("alert-create-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!this.callbacks.onCreateAlert) return;

        this.callbacks.onCreateAlert({
          base: this.selectors.alertBase?.getValue(),
          quote: this.selectors.alertQuote?.getValue(),
          condition: this.getAlertCondition(),
          target: document.getElementById("alert-target")?.value
        });
      });
    }

    // Direction is a segmented radio group, so listen on each option
    document.querySelectorAll('input[name="alert-condition-choice"]').forEach(radio => {
      radio.addEventListener("change", () => this.updateAlertRatePreview());
    });

    // Delegated handling keeps a single listener across re-renders
    const list = document.getElementById("alerts-list");
    if (list) {
      list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-alert-action]");
        if (!button) return;

        const action = button.getAttribute("data-alert-action");
        const id = button.getAttribute("data-alert-id");
        if (!id) return;

        if (action === "delete" && this.callbacks.onDeleteAlert) {
          this.callbacks.onDeleteAlert(id);
        } else if (action === "toggle" && this.callbacks.onToggleAlert) {
          this.callbacks.onToggleAlert(id, button.getAttribute("data-alert-enabled") !== "true");
        }
      });
    }

    const permissionBtn = document.getElementById("alert-permission-btn");
    if (permissionBtn) {
      permissionBtn.addEventListener("click", () => {
        if (this.callbacks.onRequestNotifications) {
          this.callbacks.onRequestNotifications();
        }
      });
    }

    this.setupAlertModal();
  }

  /** Reads the currently selected alert direction from the segmented control. */
  getAlertCondition() {
    const checked = document.querySelector('input[name="alert-condition-choice"]:checked');
    return checked ? checked.value : "above";
  }

  /**
   * Modal behaviour: open/close, backdrop and Escape dismissal, focus trapping,
   * and returning focus to whatever opened it.
   */
  setupAlertModal() {
    const modal = document.getElementById("alert-modal");
    if (!modal) return;

    this.alertModal = modal;
    this.lastFocusedBeforeModal = null;

    document.getElementById("alert-open-modal-btn")?.addEventListener("click", () => this.openAlertModal());
    document.getElementById("alert-modal-close")?.addEventListener("click", () => this.closeAlertModal());
    document.getElementById("alert-modal-cancel")?.addEventListener("click", () => this.closeAlertModal());

    // Backdrop click closes, but only when the click started on the backdrop
    modal.addEventListener("mousedown", (event) => {
      if (event.target === modal) this.closeAlertModal();
    });

    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        // Let an open currency dropdown consume Escape first
        if (modal.querySelector(".custom-select-dropdown.show")) return;
        event.stopPropagation();
        this.closeAlertModal();
        return;
      }

      if (event.key === "Tab") this.trapFocus(event, modal);
    });
  }

  /** Keeps keyboard focus inside the dialog while it is open. */
  trapFocus(event, container) {
    const focusable = [...container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null);

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  openAlertModal() {
    if (!this.alertModal) return;

    this.lastFocusedBeforeModal = document.activeElement;

    // Seed the dialog from the pair the user is currently looking at
    this.selectors.alertBase?.setValue(this.state.fromCurrency);
    this.selectors.alertQuote?.setValue(this.state.toCurrency);

    this.showAlertFormMessage("");
    const target = document.getElementById("alert-target");
    if (target) target.value = "";

    this.alertModal.hidden = false;
    document.body.style.overflow = "hidden";
    this.updateAlertRatePreview();

    // Focus the first control, not the close button
    setTimeout(() => document.querySelector("#alert-base-selector .custom-select-trigger")?.focus(), 60);
  }

  closeAlertModal() {
    if (!this.alertModal || this.alertModal.hidden) return;

    this.alertModal.hidden = true;
    document.body.style.overflow = "";

    if (this.lastFocusedBeforeModal instanceof HTMLElement) {
      this.lastFocusedBeforeModal.focus();
    }
  }

  /**
   * Attaches ripples styling to interactive buttons
   */
  setupRipples() {
    document.addEventListener("click", (e) => {
      // Ripple is reserved for primary actions; elsewhere it reads as noise
      const button = e.target.closest(".ripple");
      if (!button) return;

      button.classList.add("ripple");
      
      const circle = document.createElement("span");
      const diameter = Math.max(button.clientWidth, button.clientHeight);
      const radius = diameter / 2;

      const rect = button.getBoundingClientRect();
      circle.style.width = circle.style.height = `${diameter}px`;
      circle.style.left = `${e.clientX - rect.left - radius}px`;
      circle.style.top = `${e.clientY - rect.top - radius}px`;
      circle.classList.add("ripple-effect");

      const existingRipple = button.querySelector(".ripple-effect");
      if (existingRipple) {
        existingRipple.remove();
      }

      button.appendChild(circle);
      setTimeout(() => circle.remove(), 600);
    });
  }

  // ==========================================================================
  // Presentation helpers
  // ==========================================================================

  /**
   * Formats a signed percentage, or an em dash when the value is unavailable.
   * Unavailable never renders as 0.00% — a missing measurement and a flat
   * market must not look identical.
   */
  static formatChange(value) {
    if (!Number.isFinite(value)) return { text: "—", color: "var(--text-muted)", available: false };
    const sign = value >= 0 ? "+" : "";
    return {
      text: `${sign}${value.toFixed(2)}%`,
      color: value >= 0 ? "var(--color-success)" : "var(--color-danger)",
      available: true
    };
  }

  /** Decimal places appropriate to a rate's magnitude. */
  static precisionFor(rate) {
    if (!Number.isFinite(rate)) return 4;
    if (rate >= 1000) return 2;
    if (rate >= 10) return 3;
    return 4;
  }

  /** Renders an ISO date as a short readable label. */
  static formatISODate(iso) {
    if (!iso) return "";
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  /**
   * Builds a small inline element. Text is always set via textContent so no
   * dynamic value can be interpreted as markup.
   */
  static el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * Builds a contextual empty state. The optional action navigates to another
   * view rather than dead-ending the user.
   */
  static emptyState(iconName, title, text, action = null) {
    const block = UIManager.el("div", "state-block");

    const iconWrap = UIManager.el("div", "state-icon");
    iconWrap.appendChild(UIManager.icon(iconName));
    block.appendChild(iconWrap);

    block.appendChild(UIManager.el("p", "state-title", title));
    block.appendChild(UIManager.el("p", "state-text", text));

    if (action) {
      const button = UIManager.el("button", "btn btn-secondary btn-sm", action.label);
      button.type = "button";
      button.addEventListener("click", () => {
        document.querySelector(`.nav-tab[data-view="${action.view}"]`)?.click();
      });
      block.appendChild(button);
    }

    return block;
  }

  /**
   * References an icon from the document sprite.
   * @param {string} name Symbol id without the "i-" prefix
   */
  static icon(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (className) svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");

    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Renders a flag image for a currency code.
   */
  static flagImg(code, className = "currency-flag") {
    const img = document.createElement("img");
    img.className = className;
    img.src = `https://flagcdn.com/w40/${CurrencyAPI.CURRENCY_DETAILS[code]?.flag || "un"}.png`;
    img.alt = "";
    img.loading = "lazy";
    return img;
  }

  // ==========================================================================
  // Dashboard rendering
  // ==========================================================================

  /**
   * Refreshes dashboard analytics cards using animation counters
   */
  renderAnalyticsDashboard(stats, prevStats) {
    this.animateValue("card-total-conversions", prevStats.totalConversions, stats.totalConversions, 800);

    const countSupported = document.getElementById("card-currencies-supported");
    if (countSupported) countSupported.textContent = stats.currenciesSupported;

    const activeCurrency = document.getElementById("card-most-active-currency");
    if (activeCurrency) activeCurrency.textContent = stats.mostActiveCurrency;

    const favoritePairCard = document.getElementById("card-favorite-pair");
    if (favoritePairCard) favoritePairCard.textContent = stats.favoritePair;

    this.animateValue("card-avg-amount", prevStats.averageAmount, stats.averageConversionAmountUsd, 800, (val) => {
      return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    });

    // Replaces the former hardcoded "99.99% accuracy" figure with a real count
    // of how many currencies actually have historical coverage.
    const coverageCard = document.getElementById("card-historical-coverage");
    if (coverageCard) {
      coverageCard.textContent = `${stats.historicalCoverage} of ${stats.currenciesSupported} currencies`;
    }

    const baseLabel = document.getElementById("comparison-base-label");
    if (baseLabel) baseLabel.textContent = this.state.fromCurrency;
  }

  /**
   * Helper function for counting animations on metrics
   */
  animateValue(elementId, start, end, duration, formatFn = (val) => Math.round(val)) {
    const obj = document.getElementById(elementId);
    if (!obj) return;
    if (prefersReducedMotion()) {
      obj.textContent = formatFn(end);
      return;
    }

    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      const currentVal = progress * (end - start) + start;
      obj.textContent = formatFn(currentVal);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }

  /**
   * Renders the conversion rate summary, annotated with where the rate came
   * from and when it was retrieved.
   */
  updateConversionDisplay(rate, fromCode, toCode, meta = {}) {
    const container = document.getElementById("exchange-rate-details");
    if (!container) return;

    container.innerHTML = "";

    if (!Number.isFinite(rate) || rate <= 0) {
      container.appendChild(UIManager.el("span", "rate-line rate-line-muted", "Exchange rate unavailable for this pair."));
      return;
    }

    const decimals = UIManager.precisionFor(rate);
    container.appendChild(
      UIManager.el("span", "rate-line", `1 ${fromCode} = ${rate.toFixed(decimals)} ${toCode}`)
    );

    const stamp = meta.fetchedAt
      ? new Date(meta.fetchedAt).toLocaleString(undefined, {
          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
        })
      : "unknown";

    const note = meta.state === CurrencyAPI.STATE.CACHED
      ? `Cached · last retrieved ${stamp}`
      : `Live mid-market · updated ${stamp}`;

    container.appendChild(UIManager.el("span", "rate-line-meta", note));
  }

  /**
   * Renders the realized-volatility panel for the selected pair.
   *
   * Volatility is shown together with the one-year drift because low
   * day-to-day movement does not imply a stable currency: a managed crawl can
   * post minimal volatility while losing significant value over the year.
   */
  updateVolatilityDisplay(profile, fromCode, toCode) {
    const container = document.getElementById("converter-volatility-box");
    if (!container) return;

    container.innerHTML = "";

    if (!profile || !profile.available) {
      const card = UIManager.el("div", "vol-card vol-unavailable");
      const left = UIManager.el("div");
      left.appendChild(UIManager.el("span", "input-label vol-block-label", "Realized volatility"));
      left.appendChild(UIManager.el("span", "vol-headline", "Historical data unavailable"));
      left.appendChild(UIManager.el("span", "vol-subnote", `No ECB reference series covers ${fromCode}/${toCode}`));
      card.appendChild(left);
      card.appendChild(UIManager.el("span", "vol-risk-pill", "—"));
      container.appendChild(card);
      return;
    }

    const card = UIManager.el("div", `vol-card ${profile.colorClass}`);

    const left = UIManager.el("div");
    left.appendChild(UIManager.el("span", "input-label vol-block-label", "Realized volatility · 1Y annualized"));
    left.appendChild(UIManager.el("span", "vol-headline", `${profile.annualizedPct.toFixed(2)}%`));

    // Drift is shown alongside so a low score cannot be read as "safe"
    const drift = Number.isFinite(profile.drift1YPct)
      ? `${profile.volatility} · 1Y move ${profile.drift1YPct >= 0 ? "+" : ""}${profile.drift1YPct.toFixed(2)}%`
      : profile.volatility;
    left.appendChild(UIManager.el("span", "vol-subnote", drift));

    card.appendChild(left);
    card.appendChild(UIManager.el("span", "vol-risk-pill", `${profile.riskScore}/10`));
    container.appendChild(card);
  }

  /**
   * Renders the top gainers/losers lists from observed performance.
   */
  renderMovers(movers) {
    const renderList = (containerId, list, isGainer) => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";

      if (!movers.available || list.length === 0) {
        container.appendChild(UIManager.el("div", "list-empty", "Data unavailable"));
        return;
      }

      list.forEach(item => {
        const row = UIManager.el("div", "mover-row");

        const info = UIManager.el("div", "currency-info-col");
        info.appendChild(UIManager.flagImg(item.code));

        const nameBlock = UIManager.el("div");
        nameBlock.appendChild(UIManager.el("span", "mover-code", item.code));
        nameBlock.appendChild(UIManager.el("span", "mover-name-block", item.name));
        info.appendChild(nameBlock);

        const values = UIManager.el("div", "mover-values");
        const change = UIManager.formatChange(item.change);

        const pct = UIManager.el("span", `mover-percentage ${isGainer ? "trend-up" : "trend-down"}`);
        pct.appendChild(UIManager.icon(isGainer ? "up" : "down", "delta-arrow"));
        pct.appendChild(document.createTextNode(` ${change.text}`));

        values.appendChild(pct);
        values.appendChild(UIManager.el("span", "mover-rate", item.rate.toFixed(UIManager.precisionFor(item.rate))));

        row.appendChild(info);
        row.appendChild(values);
        container.appendChild(row);
      });
    };

    renderList("top-gainers-list", movers.gainers, true);
    renderList("top-losers-list", movers.losers, false);

    const asOf = document.getElementById("movers-as-of");
    if (asOf) {
      asOf.textContent = movers.available && movers.asOf
        ? `ECB reference rates · session ending ${UIManager.formatISODate(movers.asOf)}`
        : "Historical data unavailable";
    }
  }

  /**
   * Renders the realized-volatility leaderboard, replacing the previously
   * hardcoded example cards.
   */
  renderVolatilityLeaderboard(rows, baseCurrency) {
    const container = document.getElementById("volatility-leaderboard");
    if (!container) return;

    const baseLabel = document.getElementById("volatility-base-label");
    if (baseLabel) baseLabel.textContent = baseCurrency;

    container.innerHTML = "";

    if (!rows || rows.length === 0) {
      container.appendChild(UIManager.el("div", "list-empty", "Historical data unavailable for this base currency."));
      return;
    }

    rows.forEach(row => {
      const card = UIManager.el("div", `vol-card ${row.colorClass}`);

      const left = UIManager.el("div");
      left.appendChild(UIManager.el("span", "vol-pair-title", row.pair));

      const detail = Number.isFinite(row.drift1YPct)
        ? `${row.annualizedPct.toFixed(2)}% annualized · 1Y move ${row.drift1YPct >= 0 ? "+" : ""}${row.drift1YPct.toFixed(2)}%`
        : `${row.annualizedPct.toFixed(2)}% annualized`;
      left.appendChild(UIManager.el("span", "vol-subnote", detail));

      card.appendChild(left);
      card.appendChild(UIManager.el("span", "vol-risk-pill", `${row.volatility} · ${row.riskScore}/10`));
      container.appendChild(card);
    });
  }

  /**
   * Renders the multi-currency comparison table from observed changes.
   */
  renderComparisonTable(rows) {
    const tbody = document.getElementById("comparison-table-body");
    if (!tbody) return;

    tbody.innerHTML = "";

    rows.forEach(row => {
      const tr = document.createElement("tr");

      // Currency
      const nameCell = document.createElement("td");
      const cell = UIManager.el("div", "table-currency-cell");
      cell.appendChild(UIManager.flagImg(row.code));

      const label = UIManager.el("span", null, row.code);
      label.appendChild(UIManager.el("span", "table-currency-name", row.name));
      cell.appendChild(label);
      nameCell.appendChild(cell);
      tr.appendChild(nameCell);

      // Rate
      const rateCell = UIManager.el("td", "table-rate-cell num-col");
      rateCell.textContent = Number.isFinite(row.rate)
        ? row.rate.toFixed(UIManager.precisionFor(row.rate))
        : "—";
      tr.appendChild(rateCell);

      // Changes
      [row.change1D, row.change7D].forEach(value => {
        const change = UIManager.formatChange(value);
        const td = UIManager.el("td", "num-col");
        td.style.color = change.color;
        td.style.fontWeight = "600";

        if (change.available) {
          td.textContent = change.text;
        } else {
          td.textContent = "—";
          td.title = "No ECB historical series for this pair";
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  /**
   * Renders the conversion transactions logs list table
   */
  renderConversionHistory(history) {
    const list = document.getElementById("conversion-history-list");
    if (!list) return;

    list.innerHTML = "";

    if (history.length === 0) {
      list.appendChild(UIManager.emptyState(
        "inbox",
        "No transactions yet",
        "Conversions you record will appear here as an auditable ledger.",
        { label: "Open converter", view: "dashboard" }
      ));
      return;
    }

    history.forEach(entry => {
      const date = new Date(entry.timestamp);
      const fromSymbol = CurrencyAPI.CURRENCY_DETAILS[entry.from]?.symbol || "";
      const toSymbol = CurrencyAPI.CURRENCY_DETAILS[entry.to]?.symbol || "";

      const item = UIManager.el("div", "history-item");

      // Date column
      const meta = UIManager.el("div", "history-meta");
      meta.appendChild(UIManager.el("span", "history-timestamp-block",
        date.toLocaleDateString(undefined, { day: "numeric", month: "short" })));
      meta.appendChild(UIManager.el("span", "history-timestamp",
        date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })));
      item.appendChild(meta);

      // Pair column
      const badge = UIManager.el("div", "history-badge");
      badge.appendChild(UIManager.el("span", "history-pair", `${entry.from} → ${entry.to}`));
      badge.appendChild(UIManager.el("span", "history-rate-factor", `Rate ${entry.rate.toFixed(4)}`));
      item.appendChild(badge);

      // Amounts column
      const values = UIManager.el("div", "history-values");
      values.appendChild(UIManager.el("span", "history-calc",
        `${toSymbol}${entry.result.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
      values.appendChild(UIManager.el("span", "history-rate-factor",
        `from ${fromSymbol}${entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
      item.appendChild(values);

      list.appendChild(item);
    });
  }

  /**
   * Renders the timeframe change table beneath the chart. Timeframes with no
   * complete window render as "—" rather than a fabricated zero.
   */
  renderTrendAnalysisPanel(performances, fromCode, toCode) {
    const panel = document.getElementById("trend-analysis-panel");
    if (!panel) return;

    panel.innerHTML = "";

    const grid = UIManager.el("div", "trend-grid");
    const labels = { "1D": "1 day", "7D": "7 days", "30D": "30 days", "1Y": "1 year" };

    Object.entries(labels).forEach(([timeframe, label]) => {
      const change = UIManager.formatChange(performances[timeframe]);

      const box = UIManager.el("div", "trend-box");
      box.appendChild(UIManager.el("span", "input-label trend-box-label", label));

      const value = UIManager.el("span", "trend-box-value", change.text);
      value.style.color = change.color;
      box.appendChild(value);

      if (!change.available) box.title = "Insufficient historical observations for this window";
      grid.appendChild(box);
    });

    panel.appendChild(grid);

    // Favourite toggle reflects the current pair
    const favoriteBtn = document.getElementById("favorite-pair-trigger");
    if (favoriteBtn) {
      const pair = `${fromCode}/${toCode}`;
      const isFavorite = StorageManager.getFavoritePairs().includes(pair);
      const labelSpan = favoriteBtn.querySelector("span");

      favoriteBtn.classList.toggle("active", isFavorite);
      favoriteBtn.setAttribute("aria-pressed", String(isFavorite));
      if (labelSpan) labelSpan.textContent = isFavorite ? "Favourited" : "Add to Favourites";
    }
  }

  /**
   * Renders the market overview cards from observed performance and volatility.
   */
  renderMarketOverview(overview) {
    const setCard = (valueId, noteId, text, note, color) => {
      const valueEl = document.getElementById(valueId);
      if (valueEl) valueEl.textContent = text;

      const noteEl = document.getElementById(noteId);
      if (noteEl) {
        noteEl.textContent = note;
        if (color) noteEl.style.color = color;
      }
    };

    if (!overview.available) {
      ["market-strongest", "market-weakest", "market-volatile", "market-steadiest"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
      });
      ["market-strongest-note", "market-weakest-note", "market-volatile-note", "market-steadiest-note"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "Historical data unavailable";
      });
      return;
    }

    const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

    if (overview.strongest) {
      setCard("market-strongest", "market-strongest-note",
        overview.strongest.code,
        `${pct(overview.strongest.change1Y)} vs ${overview.base} (1Y)`,
        "var(--color-success)");
    }

    if (overview.weakest) {
      setCard("market-weakest", "market-weakest-note",
        overview.weakest.code,
        `${pct(overview.weakest.change1Y)} vs ${overview.base} (1Y)`,
        "var(--color-danger)");
    }

    if (overview.mostVolatile) {
      setCard("market-volatile", "market-volatile-note",
        overview.mostVolatile.code,
        `${overview.mostVolatile.volatility.toFixed(2)}% annualized`,
        "var(--color-danger)");
    }

    if (overview.steadiest) {
      setCard("market-steadiest", "market-steadiest-note",
        overview.steadiest.code,
        `${overview.steadiest.volatility.toFixed(2)}% annualized`,
        "var(--color-primary)");
    }
  }

  // ==========================================================================
  // Data provenance
  // ==========================================================================

  /**
   * Shows skeletons shaped like the content they stand in for, while the
   * historical dataset loads. Placeholder numbers are never rendered — an
   * in-progress figure must not be mistakable for a real one.
   */
  renderMarketSkeletons() {
    const rows = (container, count, withFlag) => {
      if (!container) return;
      container.innerHTML = "";

      for (let i = 0; i < count; i++) {
        const row = UIManager.el("div", "mover-row");

        const left = UIManager.el("div", "currency-info-col");
        if (withFlag) {
          const flag = UIManager.el("span", "skeleton");
          flag.style.width = "22px";
          flag.style.height = "16px";
          left.appendChild(flag);
        }

        const lines = UIManager.el("div");
        const a = UIManager.el("span", "skeleton skeleton-line w-40");
        a.style.display = "block";
        const b = UIManager.el("span", "skeleton skeleton-line w-60");
        b.style.display = "block";
        b.style.marginTop = "5px";
        b.style.height = "9px";
        lines.appendChild(a);
        lines.appendChild(b);
        left.appendChild(lines);

        const value = UIManager.el("span", "skeleton skeleton-line");
        value.style.width = "52px";

        row.appendChild(left);
        row.appendChild(value);
        container.appendChild(row);
      }
    };

    rows(document.getElementById("top-gainers-list"), 3, true);
    rows(document.getElementById("top-losers-list"), 3, true);
    rows(document.getElementById("volatility-leaderboard"), 3, false);

    // Market overview tiles
    ["market-strongest", "market-weakest", "market-volatile", "market-steadiest"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = "—";
        el.classList.add("skeleton");
        el.style.width = "88px";
      }
    });
  }

  /** Removes skeleton styling from the market overview tiles. */
  clearMarketSkeletons() {
    ["market-strongest", "market-weakest", "market-volatile", "market-steadiest"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove("skeleton");
        el.style.width = "";
      }
    });
  }

  /**
   * Surfaces where the data on screen came from and how fresh it is, so live,
   * cached and unavailable states are never mistaken for one another.
   */
  updateDataSourceIndicator(live, history) {
    const statusLabel = document.getElementById("connection-status");
    const badge = document.getElementById("status-badge-container");

    if (statusLabel) {
      if (live.state === CurrencyAPI.STATE.LIVE) statusLabel.textContent = "Live market rates connected";
      else if (live.state === CurrencyAPI.STATE.CACHED) statusLabel.textContent = "Offline — showing cached rates";
      else statusLabel.textContent = "Rates unavailable";
    }

    if (badge) {
      badge.classList.remove("status-live", "status-cached", "status-error");
      badge.classList.add(
        live.state === CurrencyAPI.STATE.LIVE ? "status-live"
          : live.state === CurrencyAPI.STATE.CACHED ? "status-cached"
          : "status-error"
      );
    }

    const sourceNote = document.getElementById("market-data-source");
    if (sourceNote) {
      sourceNote.innerHTML = "";

      if (history.state === CurrencyAPI.STATE.ERROR || !history.dates || history.dates.length === 0) {
        sourceNote.appendChild(UIManager.el("span", null, "Historical data unavailable — analytics cannot be computed."));
        return;
      }

      const lastDate = history.dates[history.dates.length - 1];
      const prefix = history.state === CurrencyAPI.STATE.CACHED ? "Cached ECB data" : "ECB reference rates";
      sourceNote.appendChild(UIManager.el(
        "span",
        null,
        `${prefix} via Frankfurter · ${history.dates.length} observations to ${UIManager.formatISODate(lastDate)}`
      ));
    }
  }

  // ==========================================================================
  // Rate alerts
  // ==========================================================================

  /**
   * Shows the live rate for the pair currently selected in the alert form,
   * giving the user a reference point for the threshold they are setting.
   */
  updateAlertRatePreview() {
    const preview = document.getElementById("alert-rate-preview");
    if (!preview) return;

    preview.innerHTML = "";

    const base = this.selectors.alertBase?.getValue();
    const quote = this.selectors.alertQuote?.getValue();

    if (!base || !quote || base === quote) {
      preview.appendChild(UIManager.el("span", null, "Select two different currencies."));
      return;
    }

    const rate = AlertsManager.resolveRate(this.state.rates || {}, base, quote);

    if (rate === null) {
      preview.appendChild(UIManager.el("span", null, `Live rate unavailable for ${base}/${quote}.`));
      return;
    }

    preview.appendChild(UIManager.el("span", null, `Current ${base}/${quote}`));
    preview.appendChild(UIManager.el("strong", null, rate.toFixed(UIManager.precisionFor(rate))));
  }

  /** Displays a validation or status message on the alert form. */
  showAlertFormMessage(message, type = "error") {
    const box = document.getElementById("alert-form-message");
    if (!box) return;

    box.innerHTML = "";
    box.className = `form-message form-message-${type}`;
    box.hidden = !message;

    if (message) {
      box.appendChild(UIManager.icon(type === "error" ? "warning" : "check"));
      box.appendChild(UIManager.el("span", null, message));
    }
  }

  /**
   * Renders the alert list. Every dynamic value is written with textContent,
   * and currency codes are already whitelisted by AlertsManager, so stored
   * alert data can never be interpreted as markup.
   */
  renderAlerts(alerts, rates) {
    const list = document.getElementById("alerts-list");
    const countEl = document.getElementById("alerts-active-count");
    if (!list) return;

    list.innerHTML = "";

    if (countEl) {
      const active = alerts.filter(alert => alert.enabled).length;
      countEl.textContent = String(active);
      countEl.setAttribute("data-count", String(active));
    }

    if (alerts.length === 0) {
      list.appendChild(UIManager.emptyState(
        "bell",
        "No alerts yet",
        "Create an alert to be notified when a currency pair crosses a rate you choose."
      ));
      return;
    }

    alerts.forEach(alert => {
      const currentRate = AlertsManager.resolveRate(rates || {}, alert.base, alert.quote);
      const decimals = AlertsManager.precisionFor(currentRate ?? alert.target);

      // Recently fired and not yet re-armed
      const isTriggered = alert.enabled && Boolean(alert.lastTriggeredAt) && !alert.armed;

      const item = UIManager.el("div",
        `alert-item${alert.enabled ? "" : " alert-item-disabled"}${isTriggered ? " alert-item-triggered" : ""}`);

      // --- Flag
      const pairBox = UIManager.el("div", "alert-pairbox");
      pairBox.appendChild(UIManager.flagImg(alert.quote, "alert-flag"));
      item.appendChild(pairBox);

      // --- Pair, condition, current level, state
      const main = UIManager.el("div", "alert-main");

      const pairRow = UIManager.el("div", "alert-pair-row");
      pairRow.appendChild(UIManager.el("span", "alert-pair", `${alert.base}/${alert.quote}`));

      const badge = UIManager.el("span", `alert-condition-badge alert-${alert.condition}`);
      badge.appendChild(UIManager.icon(alert.condition === AlertsManager.CONDITIONS.ABOVE ? "up" : "down"));
      badge.appendChild(document.createTextNode(alert.target.toFixed(decimals)));
      pairRow.appendChild(badge);
      main.appendChild(pairRow);

      const detail = UIManager.el("div", "alert-detail");
      if (currentRate === null) {
        detail.textContent = "Live rate unavailable";
      } else {
        const distance = ((currentRate - alert.target) / alert.target) * 100;
        detail.textContent =
          `Now ${currentRate.toFixed(decimals)} · ${Math.abs(distance).toFixed(2)}% ` +
          `${currentRate >= alert.target ? "above" : "below"} target`;
      }
      main.appendChild(detail);

      main.appendChild(UIManager.alertStatusLine(alert));
      item.appendChild(main);

      // --- Controls
      const actions = UIManager.el("div", "alert-actions");

      const toggle = UIManager.el("button", "btn btn-secondary btn-sm", alert.enabled ? "Pause" : "Resume");
      toggle.type = "button";
      toggle.setAttribute("data-alert-action", "toggle");
      toggle.setAttribute("data-alert-id", alert.id);
      toggle.setAttribute("data-alert-enabled", String(alert.enabled));
      toggle.setAttribute("aria-label", `${alert.enabled ? "Pause" : "Resume"} alert for ${alert.base} to ${alert.quote}`);

      const remove = UIManager.el("button", "btn btn-danger btn-sm btn-icon");
      remove.type = "button";
      remove.appendChild(UIManager.icon("trash"));
      remove.setAttribute("data-alert-action", "delete");
      remove.setAttribute("data-alert-id", alert.id);
      remove.setAttribute("aria-label", `Delete alert for ${alert.base} to ${alert.quote}`);

      actions.appendChild(toggle);
      actions.appendChild(remove);
      item.appendChild(actions);

      list.appendChild(item);
    });
  }

  /**
   * One-line alert state: Paused, Triggered (awaiting re-arm), or Waiting.
   */
  static alertStatusLine(alert) {
    if (!alert.enabled) {
      return UIManager.el("div", "alert-status alert-status-paused", "Paused");
    }

    if (alert.lastTriggeredAt) {
      const when = new Date(alert.lastTriggeredAt).toLocaleString(undefined, {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
      });

      return alert.armed
        ? UIManager.el("div", "alert-status alert-status-armed", `Waiting · last triggered ${when}`)
        : UIManager.el("div", "alert-status alert-status-triggered", `Triggered ${when} · re-arms when the rate crosses back`);
    }

    return UIManager.el("div", "alert-status alert-status-armed", "Waiting for crossing");
  }

  /**
   * Reflects the browser notification permission state, including the case
   * where notifications are unsupported or the user has blocked them.
   */
  renderNotificationStatus(status) {
    const box = document.getElementById("alert-permission-status");
    const button = document.getElementById("alert-permission-btn");
    if (!box) return;

    const states = {
      unsupported: {
        icon: "warning",
        cls: "permission-warning",
        text: "This browser does not support notifications. Alerts still appear in the app while it is open.",
        showButton: false
      },
      granted: {
        icon: "check",
        cls: "permission-ok",
        text: "Notifications enabled. Alerts are checked while the app is open.",
        showButton: false
      },
      denied: {
        icon: "warning",
        cls: "permission-warning",
        text: "Notifications are blocked in your browser settings. Alerts still appear in the app; you can re-enable notifications from the padlock icon in the address bar.",
        showButton: false
      },
      default: {
        icon: "info",
        cls: "",
        text: "Enable notifications to be told when a rate crosses your target.",
        showButton: true
      }
    };

    const state = states[status] || states.default;

    box.className = `permission-status ${state.cls}`.trim();
    box.innerHTML = "";
    box.appendChild(UIManager.icon(state.icon));
    box.appendChild(UIManager.el("span", null, state.text));

    button?.classList.toggle("hidden", !state.showButton);
  }

  /**
   * Displays temporary premium visual toast messages
   */
  showToast(message, type = "success", title = null) {
    const region = document.getElementById("toast-region") || document.body;
    const toast = UIManager.el("div", `app-toast app-toast-${type}`);

    const iconName = type === "success" ? "check" : type === "warning" ? "warning" : "error";
    const iconWrap = UIManager.el("span", "app-toast-icon");
    iconWrap.appendChild(UIManager.icon(iconName));
    toast.appendChild(iconWrap);

    const body = UIManager.el("div", "app-toast-body");
    if (title) {
      body.appendChild(UIManager.el("div", "app-toast-title", title));
      body.appendChild(UIManager.el("div", "app-toast-text", message));
    } else {
      body.appendChild(UIManager.el("div", "app-toast-title", message));
    }
    toast.appendChild(body);

    region.appendChild(toast);
    toast.classList.add("toast-in");

    setTimeout(() => {
      toast.classList.replace("toast-in", "toast-out");
      setTimeout(() => toast.remove(), 220);
    }, title ? 5000 : 3500);
  }
}
