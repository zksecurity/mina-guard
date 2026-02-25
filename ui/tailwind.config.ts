import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        safe: {
          green: '#12FF80',
          dark: '#121312',
          gray: '#1C1C1C',
          border: '#303033',
          text: '#A1A3A7',
          hover: '#1A2A1F',
        },
      },
    },
  },
  plugins: [],
};

export default config;
