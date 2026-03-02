/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#EFF6FF",
          100: "#DBEAFE",
          500: "#3B82F6",
          600: "#2563EB"
        },
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
