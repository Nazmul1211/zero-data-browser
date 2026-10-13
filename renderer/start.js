const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const trackersStat = document.getElementById("trackersStat");
const identityStat = document.getElementById("identityStat");
const modeStat = document.getElementById("modeStat");

searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    const hasDot = query.includes('.');
    const hasSpace = query.includes(' ');

    if (hasDot && !hasSpace) {
        // Looks like a URL
        window.location.href = query.startsWith('http') ? query : `https://${query}`;
    } else {
        // It's a search query — navigate using the user's configured search engine
        if (window.startAPI && window.startAPI.getSearchUrl) {
            const url = await window.startAPI.getSearchUrl(query);
            window.location.href = url;
        } else {
            // Fallback if preload somehow failed
            window.location.href = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
        }
    }
});

// Focus the search box on load
document.getElementById('searchInput').focus();

if (window.startAPI) {
    if (window.startAPI.getStats) {
        window.startAPI.getStats().then(stats => {
            if (trackersStat) trackersStat.textContent = stats.trackersBlocked || 0;
            if (identityStat) identityStat.textContent = stats.identity || "Personal";
            if (modeStat) modeStat.textContent = stats.privacyMode || "Standard";
        }).catch(console.error);
    }

    // Initialize Theme
    if (window.startAPI.getTheme) {
        window.startAPI.getTheme().then(theme => {
            document.body.classList.toggle("theme-light", theme === "light");
        });
    }

    // Listen for global theme changes
    if (window.startAPI.onThemeChanged) {
        window.startAPI.onThemeChanged(theme => {
            document.body.classList.toggle("theme-light", theme === "light");
        });
    }

    // Handle Theme Toggle Button Click
    const themeToggleBtn = document.getElementById("themeToggleBtn");
    if (themeToggleBtn && window.startAPI.toggleTheme) {
        themeToggleBtn.addEventListener("click", () => {
            window.startAPI.toggleTheme();
        });
    }
}
