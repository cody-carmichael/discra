(function () {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealNodes = Array.from(document.querySelectorAll("[data-reveal]"));
  if (revealNodes.length) {
    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      revealNodes.forEach(function (node) {
        node.classList.add("is-visible");
      });
    } else {
      const observer = new IntersectionObserver(
        function (entries, activeObserver) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) {
              return;
            }
            entry.target.classList.add("is-visible");
            activeObserver.unobserve(entry.target);
          });
        },
        {
          threshold: 0.16,
          rootMargin: "0px 0px -6% 0px",
        }
      );
      revealNodes.forEach(function (node, index) {
        node.style.setProperty("--reveal-delay", Math.min(index * 90, 560) + "ms");
        observer.observe(node);
      });
    }
  }

  if (prefersReducedMotion) {
    return;
  }

  const parallaxNodes = Array.from(document.querySelectorAll("[data-parallax-speed]"));
  if (!parallaxNodes.length) {
    return;
  }

  let ticking = false;
  function renderParallax() {
    const y = window.scrollY || 0;
    parallaxNodes.forEach(function (node) {
      const speed = Number.parseFloat(node.getAttribute("data-parallax-speed") || "0");
      if (!Number.isFinite(speed) || !speed) {
        return;
      }
      const offset = y * speed;
      node.style.transform = "translate3d(0, " + offset.toFixed(2) + "px, 0)";
    });
    ticking = false;
  }

  function onScroll() {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(renderParallax);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  renderParallax();
})();
