/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      fontFamily: { sans: ['"IBM Plex Sans Thai"', 'system-ui', 'sans-serif'] },
      colors: {
        paper: 'var(--paper)', card: 'var(--card)', ink: 'var(--ink)', mute: 'var(--mute)', line: 'var(--line)',
        soft: 'var(--soft)', nara: 'var(--A)', pray: 'var(--B)', in: 'var(--in)', out: 'var(--out)', re: 'var(--re)', hi: 'var(--hi)',
      },
    },
  },
  plugins: [],
}
