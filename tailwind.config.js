/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // The brand blue. Green and red are reserved for state (done / failed).
        brand: {
          DEFAULT: '#0b8fe8',
          hover: '#0a80d0',
          subtle: '#0b8fe81a',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
