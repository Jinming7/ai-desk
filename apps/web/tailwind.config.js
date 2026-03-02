/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#EAF2FF",
          100: "#D7E8FF",
          500: "#0064FF",
          600: "#0052D6"
        },
        cyan: "#33DDFF",
        ink: "#1F2937",
        muted: "#6B7280",
        line: "#E5E7EB"
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
