(() => {
  const canvas = document.querySelector("#docQr");
  const meta = document.querySelector("#qrMeta");

  try {
    const code = QuadQR.encodeText("QuadQR library docs - browser + Node + secure payloads", { ecc: "M" });
    QuadQR.renderToCanvas(code, canvas, { moduleSize: 7, quietZone: 3, style: "classic" });
    meta.textContent = `v${code.version} · ${code.size}×${code.size}`;
  } catch (error) {
    meta.textContent = error.message;
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.parentElement.querySelector("code")?.textContent || "";
      await navigator.clipboard.writeText(code);
      const previous = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = previous; }, 1200);
    });
  });

  const links = [...document.querySelectorAll(".sidebar a[href^='#']")];
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-20% 0px -65%", threshold: [0, .2, .6] });
  sections.forEach((section) => observer.observe(section));
})();
