/* The DNR rule places the original URL in the fragment, never a server query. */
(async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "mv3-prepare-go-and-fill",
      // Do not decodeURIComponent: escapes belong to the original destination.
      url: location.hash.slice(1)
    });
    if (!response?.url || response.error) {
      throw new Error(response?.error || "The extension did not return a destination.");
    }
    const destination = new URL(response.url);
    if (!["http:", "https:"].includes(destination.protocol)) {
      throw new Error("The destination must use HTTP or HTTPS.");
    }
    location.replace(destination.href);
  } catch (error) {
    document.getElementById("status").textContent = "Unable to open this login: " + error.message;
  }
})();
