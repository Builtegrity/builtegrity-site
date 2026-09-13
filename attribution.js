(() => {
  const key = "builtegrityAttribution";
  const fields = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
  const params = new URLSearchParams(location.search);
  const incoming = Object.fromEntries(fields.map(field => [field, (params.get(field) || "").slice(0, 200)]));
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(key)); } catch {}
  let externalHost = "";
  try {
    const ref = new URL(document.referrer);
    if (ref.hostname.replace(/^www\./, "") !== location.hostname.replace(/^www\./, "")) externalHost = ref.hostname;
  } catch {}
  const tagged = fields.some(field => incoming[field]);
  const data = tagged
    ? { ...incoming, source: incoming.utm_source || externalHost || "Unknown (tagged visit)" }
    : externalHost
      ? { source: externalHost }
      : saved && typeof saved.source === "string" ? saved : { source: "Direct / unknown" };
  window.builtegrityAttribution = data;
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
  // Carry only attribution through internal request links, including when storage is blocked.
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('a[href="/request/"]').forEach(link => {
      const url = new URL(link.href);
      url.searchParams.set("utm_source", data.source);
      fields.slice(1).forEach(field => {
        if (data[field]) url.searchParams.set(field, data[field]);
      });
      link.href = url.pathname + url.search;
    });
  });
})();
