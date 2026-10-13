document.addEventListener('DOMContentLoaded', () => {

    // ── Reveal Animations on Scroll ─────────────────────────────
    const reveals = document.querySelectorAll('.reveal');

    const revealOnScroll = () => {
        const windowHeight = window.innerHeight;
        const elementVisible = 100;
        reveals.forEach(reveal => {
            const elementTop = reveal.getBoundingClientRect().top;
            if (elementTop < windowHeight - elementVisible) {
                reveal.classList.add('active');
            }
        });
    };

    window.addEventListener('scroll', revealOnScroll);
    revealOnScroll();

    // ── Glowing Aura Mouse Follower ──────────────────────────────
    const auraBg = document.querySelector('.aura-bg');
    document.addEventListener('mousemove', (e) => {
        setTimeout(() => {
            auraBg.style.left = `${e.clientX}px`;
            auraBg.style.top  = `${e.clientY}px`;
        }, 50);
    });

    // ── Smart Privacy Modes Tab Switcher ─────────────────────────
    const modeTabs   = document.querySelectorAll('.mode-tab');
    const modePanels = document.querySelectorAll('.mode-panel');

    /**
     * Animate the speed bar inside the given panel.
     * Uses a small delay so the bar visibly fills after the panel appears.
     */
    function animateSpeedBar(panel) {
        const bar = panel.querySelector('.speed-bar');
        if (!bar) return;
        bar.classList.remove('animated');
        // Force a reflow so the transition fires fresh every time
        void bar.offsetWidth;
        requestAnimationFrame(() => {
            setTimeout(() => bar.classList.add('animated'), 60);
        });
    }

    /**
     * Switch to the given mode tab.
     * @param {string} mode - 'standard' | 'strong' | 'maximum'
     */
    function switchMode(mode) {
        // Update tab buttons
        modeTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        // Update panels
        modePanels.forEach(panel => {
            const isTarget = panel.id === `panel-${mode}`;
            panel.classList.toggle('active', isTarget);
            if (isTarget) animateSpeedBar(panel);
        });
    }

    // Wire up tab click events
    modeTabs.forEach(tab => {
        tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    });

    // Animate the speed bar for the initially-active panel on first load
    const initialPanel = document.querySelector('.mode-panel.active');
    if (initialPanel) {
        // Only animate once the section scrolls into view
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    animateSpeedBar(initialPanel);
                    observer.disconnect();
                }
            });
        }, { threshold: 0.25 });

        const modesSection = document.getElementById('privacy-modes');
        if (modesSection) observer.observe(modesSection);
    }

    // Keyboard navigation for tabs (left / right arrow)
    const tabsContainer = document.getElementById('modeTabs');
    if (tabsContainer) {
        tabsContainer.addEventListener('keydown', (e) => {
            const tabList = [...modeTabs];
            const activeIdx = tabList.findIndex(t => t.classList.contains('active'));
            if (e.key === 'ArrowRight') {
                const next = tabList[(activeIdx + 1) % tabList.length];
                next.focus();
                switchMode(next.dataset.mode);
            } else if (e.key === 'ArrowLeft') {
                const prev = tabList[(activeIdx - 1 + tabList.length) % tabList.length];
                prev.focus();
                switchMode(prev.dataset.mode);
            }
        });
        modeTabs.forEach(tab => tab.setAttribute('tabindex', '0'));
    }
});
