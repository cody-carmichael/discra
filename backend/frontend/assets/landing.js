(function () {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealNodes = Array.from(document.querySelectorAll("[data-reveal]"));
  if (!revealNodes.length) {
    return;
  }

  if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
    revealNodes.forEach(function (node) {
      node.classList.add("is-visible");
    });
    return;
  }

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
})();
