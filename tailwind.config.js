/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /*
          The brand blue, plus the two derivatives that stop every component
          inventing its own. `subtle` is the wash behind an active state;
          `ring` is the halo on a focused or dragged-over surface. Both are
          alpha, so they compose over whatever surface they land on instead of
          needing a light and a dark variant.
        */
        brand: {
          DEFAULT: '#0b8fe8',
          hover: '#38a6f2',
          deep: '#0873bd',
          subtle: 'rgb(11 143 232 / 0.12)',
          ring: 'rgb(11 143 232 / 0.35)',
        },
        /*
          The dark surface ladder.

          Tailwind's `slate` was the placeholder and it reads flat and blue-grey
          on a large dark canvas — every panel the same value as the window
          behind it. These are near-black with a slight cool cast and real
          separation between steps, so a modal reads as sitting *above* the
          window rather than being painted on it.
        */
        ink: {
          950: '#070a0f',
          900: '#0a0e15',
          850: '#0e131c',
          800: '#131924',
          750: '#18202d',
          700: '#1f2836',
          600: '#2b3646',
          500: '#3d4a5c',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable Text',
          'Segoe UI',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      boxShadow: {
        /* A hairline highlight along the top edge plus a soft drop. This is what
           makes a panel look lit from above rather than pasted on. */
        panel: 'inset 0 1px 0 0 rgb(255 255 255 / 0.05), 0 1px 2px 0 rgb(0 0 0 / 0.35)',
        lift: 'inset 0 1px 0 0 rgb(255 255 255 / 0.06), 0 18px 40px -18px rgb(0 0 0 / 0.7)',
        modal: '0 32px 80px -24px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(255 255 255 / 0.06)',
        /* Reserved for the primary action and the drag-over state. Nothing else
           glows, or the glow stops meaning anything. */
        glow: '0 6px 24px -8px rgb(11 143 232 / 0.55)',
        'glow-lg': '0 12px 48px -12px rgb(11 143 232 / 0.45)',
      },
      backgroundImage: {
        'brand-sheen': 'linear-gradient(180deg, #2a9df0 0%, #0b8fe8 55%, #0b83d6 100%)',
      },
      transitionTimingFunction: {
        /* Slightly overshooting ease-out. Desktop UI feels mechanical on a
           linear curve and toy-like on a bouncy one; this sits between. */
        crisp: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pulse-ring': {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(1.04)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'pulse-ring': 'pulse-ring 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
