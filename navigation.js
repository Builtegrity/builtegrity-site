const siteMenu = document.querySelector(".site-menu");

if (siteMenu) {
  const menuButton = siteMenu.querySelector("summary");

  siteMenu.addEventListener("click", event => {
    if (event.target.closest("a")) siteMenu.removeAttribute("open");
  });

  document.addEventListener("click", event => {
    if (!siteMenu.contains(event.target)) siteMenu.removeAttribute("open");
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && siteMenu.open) {
      siteMenu.removeAttribute("open");
      menuButton.focus();
    }
  });
}
