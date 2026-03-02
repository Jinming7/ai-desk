/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#EEF3FF",
          100: "#DCE7FF",
          500: "#3366FF",
          600: "#2451D6"
        },
        ink: "#1F2937"
      },
      boxShadow: {
        soft: "0 8px 32px rgba(31, 41, 55, 0.08)"
      },
      borderRadius: {
        mdplus: "8px"
      }
    }
  },
  plugins: []
};
