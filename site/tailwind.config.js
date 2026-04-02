/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#f8f8f8',
        bg2: '#f8f8f8',
        surface: '#ffffff',
        surface2: '#f0f0f0',
        blue: '#5b6cf8',
        blue2: '#4455e8',
        green: '#16a34a',
        red: '#dc2626',
        yellow: '#d97706',
        text: '#1a1a1a',
        text2: '#444444',
        text3: '#555555',
        border: '#e2e2e2',
        // Legacy alias
        cyan: '#5b6cf8',
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
        'blue': '0 4px 24px rgba(91,108,248,0.2)',
        'blue-sm': '0 2px 12px rgba(91,108,248,0.15)',
        'card': '0 1px 3px rgba(0,0,0,0.1)',
      },
      borderColor: {
        DEFAULT: '#e2e2e2',
      },
    },
  },
  plugins: [],
}
