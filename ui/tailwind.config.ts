import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter (loaded via next/font in app/layout.tsx) is the open equivalent
        // of the system SF face the logo wordmark uses; falls back to the
        // system stack if the variable is absent.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        safe: {
          // `green` keeps its token name for compatibility with existing
          // usages, but the brand accent is now the logo's periwinkle violet.
          green: '#9683EC',
          orange: '#F2843C', // secondary accent from the logo's warm face
          dark: '#121312',
          gray: '#1C1C1C',
          border: '#303033',
          text: '#A1A3A7',
          hover: '#201A2E',
        },
      },
    },
  },
  plugins: [],
};

export default config;
