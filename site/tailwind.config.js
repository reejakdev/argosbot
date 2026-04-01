/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#04050d',
        bg2: '#080c18',
        cyan: '#00d4ff',
        green: '#00ff88',
        red: '#ff4466',
        text: '#c8d8f0',
        text2: '#6a80a8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Courier New', 'Courier', 'monospace'],
      },
      animation: {
        'spin-slow': 'spin 8s linear infinite',
        'spin-reverse': 'spin-reverse 12s linear infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'marquee': 'marquee 30s linear infinite',
      },
      keyframes: {
        'spin-reverse': {
          from: { transform: 'rotate(360deg)' },
          to: { transform: 'rotate(0deg)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 8px #00ff88' },
          '50%': { opacity: '0.4', boxShadow: '0 0 2px #00ff88' },
        },
        'marquee': {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      boxShadow: {
        'cyan': '0 0 20px rgba(0,212,255,0.3)',
        'green': '0 0 20px rgba(0,255,136,0.3)',
        'red': '0 0 20px rgba(255,68,102,0.3)',
        'cyan-lg': '0 0 40px rgba(0,212,255,0.4)',
      },
    },
  },
  plugins: [],
}
