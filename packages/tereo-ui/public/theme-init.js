// Applies the persisted (or system) theme before first paint to avoid a
// light/dark flash. Kept as a same-origin static file rather than an inline
// <script> so the strict CSP (script-src 'self', no unsafe-inline) allows it.
/* global window, document, localStorage */
(function () {
  try {
    var stored = localStorage.getItem("tereo-theme");
    var theme = stored ? JSON.parse(stored) : "system";
    var resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
