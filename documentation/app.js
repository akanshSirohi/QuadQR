
(() => {
  const themeMeta = document.querySelector('meta[name="color-scheme"]');
  const themeToggle = document.querySelector("[data-theme-toggle]");
  const themeStorageKey = "quadqr-docs-theme";
  const themeMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
  const isTheme = (value) => value === "light" || value === "dark";
  const getStoredTheme = () => {
    try {
      const value = localStorage.getItem(themeStorageKey);
      return isTheme(value) ? value : null;
    } catch {
      return null;
    }
  };
  const getSystemTheme = () => themeMedia?.matches ? "dark" : "light";
  const applyTheme = (theme) => {
    const storedTheme = isTheme(theme) ? theme : null;
    themeMeta?.setAttribute("content", storedTheme || "light dark");
    const currentTheme = storedTheme || getSystemTheme();
    themeToggle?.setAttribute("aria-label", `Switch to ${currentTheme === "dark" ? "light" : "dark"} theme`);
  };

  applyTheme(getStoredTheme());
  themeToggle?.addEventListener("click", () => {
    const currentTheme = getStoredTheme() || getSystemTheme();
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    const nextStoredTheme = nextTheme === getSystemTheme() ? null : nextTheme;
    try {
      if (nextStoredTheme) localStorage.setItem(themeStorageKey, nextStoredTheme);
      else localStorage.removeItem(themeStorageKey);
    } catch {
      // Theme still applies for this page when storage is unavailable.
    }
    applyTheme(nextStoredTheme);
  });
  themeMedia?.addEventListener?.("change", () => applyTheme(getStoredTheme()));
  window.addEventListener("storage", (event) => {
    if (event.key === themeStorageKey) applyTheme(isTheme(event.newValue) ? event.newValue : null);
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        const old = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = old; }, 1200);
      } catch {
        button.textContent = "Select & copy";
      }
    });
  });

  const sidebar = document.querySelector("[data-sidebar]");
  const menuButton = document.querySelector("[data-menu-button]");
  const menuCloseButton = document.querySelector("[data-menu-close]");
  const mainContent = document.querySelector("main.main-content");
  const backdrop = document.querySelector("[data-mobile-backdrop]");
  const mobileQuery = window.matchMedia?.("(max-width: 900px)");
  let menuOpen = false;
  const syncMenuState = (focusTrigger = false) => {
    const mobile = mobileQuery?.matches ?? false;
    if (mobile) {
      sidebar?.toggleAttribute("inert", !menuOpen);
      sidebar?.setAttribute("aria-hidden", String(!menuOpen));
      mainContent?.toggleAttribute("inert", menuOpen);
    } else {
      sidebar?.removeAttribute("inert");
      sidebar?.removeAttribute("aria-hidden");
      mainContent?.removeAttribute("inert");
    }
    menuButton?.setAttribute("aria-expanded", String(mobile && menuOpen));
    if (focusTrigger) menuButton?.focus();
  };
  const closeMenu = (focusTrigger = true) => {
    menuOpen = false;
    sidebar?.classList.remove("open");
    backdrop?.classList.remove("open");
    syncMenuState(focusTrigger);
  };
  const openMenu = () => {
    menuOpen = true;
    sidebar?.classList.add("open");
    backdrop?.classList.add("open");
    syncMenuState();
    sidebar?.querySelector("a")?.focus();
  };
  menuButton?.addEventListener("click", () => menuOpen ? closeMenu() : openMenu());
  menuCloseButton?.addEventListener("click", () => closeMenu());
  backdrop?.addEventListener("click", () => closeMenu());
  sidebar?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => closeMenu(false)));
  mobileQuery?.addEventListener?.("change", () => closeMenu(false));
  syncMenuState(false);

  const tocLinks = [...document.querySelectorAll(".toc a[href^='#']")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const sections = tocLinks.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const hit = entries.filter((x) => x.isIntersecting).sort((a,b) => b.intersectionRatio-a.intersectionRatio)[0];
      if (!hit) return;
      tocLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${hit.target.id}`));
    }, { rootMargin: "-18% 0px -72%", threshold: [0,.1,.5] });
    sections.forEach((s) => observer.observe(s));
  }

  const modal = document.querySelector("[data-search-modal]");
  const input = document.querySelector("[data-search-input]");
  const results = document.querySelector("[data-search-results]");
  const index = Array.isArray(window.QUADQR_SEARCH_INDEX) ? window.QUADQR_SEARCH_INDEX : [];
  const showEmpty = (message) => {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = message;
    results?.replaceChildren(empty);
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value), document.baseURI);
      return ["file:", "http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const openSearch = () => {
    if (!modal?.open) modal?.showModal();
    input?.focus();
  };
  const closeSearch = () => {
    if (modal?.open) modal.close();
    else {
      if (input) input.value = "";
      renderSearch("");
    }
  };
  const renderSearch = (query) => {
    if (!results) return;
    const q = query.trim().toLowerCase();
    if (!q) { showEmpty("Type to search pages and sections."); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const scored = index.map((item) => {
      const hay = `${item.title} ${item.page} ${item.text}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      let score = 0;
      if (item.title.toLowerCase().includes(q)) score += 8;
      if (item.page.toLowerCase().includes(q)) score += 4;
      score += words.reduce((n,w) => n + (item.title.toLowerCase().includes(w) ? 2 : 0), 0);
      return { item, score };
    }).filter(Boolean).sort((a,b) => b.score-a.score).slice(0,12);
    if (!scored.length) { showEmpty("No matching documentation found."); return; }
    const fragment = document.createDocumentFragment();
    scored.forEach(({ item }) => {
      const url = safeUrl(item.url);
      if (!url) return;
      const link = document.createElement("a");
      link.className = "search-result";
      link.href = url;
      const title = document.createElement("strong");
      title.textContent = item.title;
      const page = document.createElement("span");
      page.textContent = item.page;
      link.append(title, page);
      fragment.append(link);
    });
    if (fragment.childNodes.length) results.replaceChildren(fragment);
    else showEmpty("No matching documentation found.");
  };
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeSearch();
  });
  modal?.addEventListener("close", () => {
    if (input) input.value = "";
    renderSearch("");
  });
  document.querySelector("[data-search-open]")?.addEventListener("click", openSearch);
  input?.addEventListener("input", () => renderSearch(input.value));
  document.addEventListener("keydown", (event) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (event.key === "/" && !typing && !modal?.open) { event.preventDefault(); openSearch(); }
    if (event.key === "Escape" && menuOpen) closeMenu();
  });

  const canvas = document.querySelector("#docQr");
  const meta = document.querySelector("#qrMeta");
  if (canvas && meta && window.QuadQR) {
    try {
      const code = QuadQR.encodeText("QuadQR documentation", { ecc: "M", compression: "auto" });
      QuadQR.renderToCanvas(code, canvas, { moduleSize: 7, quietZone: 3, style: "classic" });
      meta.textContent = `v${code.version} · ${code.size}×${code.size} · ${code.bitsPerDataCell} bits/cell`;
    } catch (error) { meta.textContent = error.message; }
  }
})();
