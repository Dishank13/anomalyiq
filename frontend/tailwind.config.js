/**
 * AnomalyIQ design tokens.
 *
 * The governing rule: colour encodes severity and nothing else. Chrome,
 * buttons, links and focus rings are all ink. In a tool whose entire job is to
 * pull your eye to the outliers, a blue button competes with the signal.
 *
 * The three severity colours were validated for colour-vision deficiency
 * separation rather than chosen by eye (worst adjacent pair: deltaE 18.6
 * deutan, 22.1 normal vision, on the paper surface).
 */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './public/index.html'],
  theme: {
    extend: {
      colors: {
        // Surfaces: engineering paper, not a dashboard.
        paper: '#FCFCFB',
        sunk: '#F4F4F1',
        rule: '#E2E3DE',
        // Ink
        ink: '#15181B',
        graphite: '#5F666C',
        faint: '#9AA0A5',
        // Severity. Status colours, reserved: never reused as "series 4".
        high: '#B02015',
        medium: '#CE8500',
        low: '#1668B0'
      },
      fontFamily: {
        // Condensed for headings: instrument-panel labelling.
        display: ['"IBM Plex Sans Condensed"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Every numeral in the interface is monospaced, so a column of
        // z-scores can be compared by scanning it.
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      fontSize: {
        eyebrow: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.12em' }]
      },
      borderRadius: {
        // Restrained: instruments have square corners.
        DEFAULT: '3px',
        md: '4px',
        lg: '6px'
      },
      boxShadow: {
        panel: '0 1px 2px rgba(21, 24, 27, 0.04)',
        lifted: '0 2px 8px rgba(21, 24, 27, 0.08)'
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(200%)' }
        }
      },
      animation: {
        'fade-up': 'fade-up 200ms ease-out both',
        sweep: 'sweep 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
