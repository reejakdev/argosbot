/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#060b1f',
        bg2: '#0a1020',
        surface: '#0d1530',
        surface2: '#111b3a',
        blue: '#4f6eff',
        blue2: '#7b96ff',
        green: '#10b981',
        red: '#ef4444',
        yellow: '#f59e0b',
        text: '#f0f4ff',
        text2: '#94a3b8',
        // Legacy aliases for gradual migration
        cyan: '#4f6eff',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Courier New', 'Courier', 'monospace'],
      },
      animation: {
        'spin-slow': 'spin 8s linear infinite',
        'spin-reverse': 'spin-reverse 12s linear infinite',
        'pulse-soft': 'pulse-soft 3s ease-in-out infinite',
        'marquee': 'marquee 30s linear infinite',
      },
      keyframes: {
        'spin-reverse': {
          from: { transform: 'rotate(360deg)' },
          to: { transform: 'rotate(0deg)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'marquee': {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      boxShadow: {
        'blue': '0 4px 24px rgba(79,110,255,0.25)',
        'blue-sm': '0 2px 12px rgba(79,110,255,0.2)',
        'card': '0 4px 24px rgba(0,0,0,0.4)',
      },
      borderColor: {
        DEFAULT: 'rgba(79,110,255,0.15)',
      },
    },
  },
  plugins: [],
}
