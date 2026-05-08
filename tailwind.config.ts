import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // FlashForce palette — Material You / Geist-inspired vivid hues
        // 三類別主色 (固定測速 / 科技執法 / 機動測速)
        radar: {
          50: "#fff5f0",
          400: "#ff7a59",
          500: "#ff5c33",
          600: "#e8431e",
          700: "#b8331a",
        },
        ai: {
          50: "#eef9ff",
          400: "#3aa9ff",
          500: "#1284e8",
          600: "#0d68bb",
          700: "#0a4d8c",
        },
        mobile: {
          50: "#fffaeb",
          400: "#ffc043",
          500: "#f59e0b",
          600: "#c97a04",
          700: "#965a03",
        },
        ink: {
          50: "#f7f7f8",
          100: "#eceef1",
          200: "#d6dae0",
          400: "#7d8693",
          600: "#3a424d",
          900: "#0f1218",
        },
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        sketch: ["Caveat", "Patrick Hand", "Comic Sans MS", "cursive"],
      },
      boxShadow: {
        sketch: "2px 3px 0 rgba(15,18,24,0.18)",
      },
    },
  },
  plugins: [],
};

export default config;
