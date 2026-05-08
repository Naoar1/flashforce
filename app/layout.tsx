import type { Metadata, Viewport } from "next";
import "./globals.css";
import PWARegister from "../components/PWARegister";

export const metadata: Metadata = {
  title: "FlashForce — 全台科技執法・測速地圖",
  description:
    "FlashForce 提供全台固定測速、科技執法與機動測速點地圖，資料來源為政府開放資料平台與各縣市警察局公開資訊。",
  applicationName: "FlashForce",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    title: "FlashForce — 全台科技執法・測速地圖",
    description: "全台固定測速、科技執法與機動測速點，盡在 FlashForce。",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#ff5c33",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant-TW">
      <head>
        <link
          rel="preconnect"
          href="https://tile.openstreetmap.org"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Patrick+Hand&display=swap"
        />
      </head>
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
