
(() => {
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("quadqr-docs-theme");
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = savedTheme || (systemDark ? "dark" : "light");

  document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("quadqr-docs-theme", next);
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
  const backdrop = document.querySelector("[data-mobile-backdrop]");
  const closeMenu = () => { sidebar?.classList.remove("open"); backdrop?.classList.remove("open"); };
  document.querySelector("[data-menu-button]")?.addEventListener("click", () => {
    sidebar?.classList.toggle("open"); backdrop?.classList.toggle("open");
  });
  backdrop?.addEventListener("click", closeMenu);
  sidebar?.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMenu));

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
  const openSearch = () => { modal?.classList.add("open"); modal?.setAttribute("aria-hidden","false"); setTimeout(() => input?.focus(), 0); };
  const closeSearch = () => { modal?.classList.remove("open"); modal?.setAttribute("aria-hidden","true"); if (input) input.value=""; renderSearch(""); };
  const renderSearch = (query) => {
    if (!results) return;
    const q = query.trim().toLowerCase();
    if (!q) { results.innerHTML = '<div class="search-empty">Type to search pages and sections.</div>'; return; }
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
    if (!scored.length) { results.innerHTML = '<div class="search-empty">No matching documentation found.</div>'; return; }
    results.innerHTML = scored.map(({item}) => `<a class="search-result" href="${item.url}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.page)}</span></a>`).join("");
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  document.querySelector("[data-search-open]")?.addEventListener("click", openSearch);
  document.querySelector("[data-search-close]")?.addEventListener("click", closeSearch);
  input?.addEventListener("input", () => renderSearch(input.value));
  document.addEventListener("keydown", (event) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (event.key === "/" && !typing && !modal?.classList.contains("open")) { event.preventDefault(); openSearch(); }
    if (event.key === "Escape" && modal?.classList.contains("open")) closeSearch();
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
