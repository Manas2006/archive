const defaultTheme = require('tailwindcss/defaultTheme');

// Content-script UI lives inside a shadow root on pages that set their own root
// font size (OpenReview uses 10px), so every rem value is converted to px.
function remToPx(value) {
  if (typeof value === 'string') return value.replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${parseFloat(n) * 16}px`);
  if (Array.isArray(value)) return value.map(remToPx);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remToPx(v)]));
  }
  return value;
}

module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  darkMode: 'media',
  theme: {
    spacing: remToPx(defaultTheme.spacing),
    fontSize: remToPx(defaultTheme.fontSize),
    borderRadius: remToPx(defaultTheme.borderRadius),
    lineHeight: remToPx(defaultTheme.lineHeight),
    maxWidth: remToPx(defaultTheme.maxWidth({ theme: () => remToPx(defaultTheme.spacing), breakpoints: () => ({}) })),
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        serif: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', 'Georgia', 'serif'],
        mono: ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        accent: {
          50: '#effaf8',
          100: '#d6f1ec',
          200: '#ade2d9',
          300: '#7bcbbf',
          400: '#4aaea1',
          500: '#2f9285',
          600: '#22766c',
          700: '#1f5f58',
          800: '#1d4c47',
          900: '#1b3f3b',
        },
      },
    },
  },
  plugins: [],
};
