/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.html', './public/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          // 950 reuses the darkest surface token (used for code/DDL panels)
          950: 'rgb(var(--surface-900) / <alpha-value>)',
          900: 'rgb(var(--surface-900) / <alpha-value>)',
          800: 'rgb(var(--surface-800) / <alpha-value>)',
          700: 'rgb(var(--surface-700) / <alpha-value>)',
          600: 'rgb(var(--surface-600) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
