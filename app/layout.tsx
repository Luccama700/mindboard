import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mindboard",
  description: "Personal life dashboard",
  manifest: "/manifest.webmanifest",
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Mindboard",
    statusBarStyle: "black-translucent",
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#0d0d0d",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='cream'){document.documentElement.classList.add('theme-cream')}var a=localStorage.getItem(t==='cream'?'accent-cream':'accent-dark');if(a&&/^#[0-9a-fA-F]{6}$/.test(a)){document.documentElement.style.setProperty('--accent',a)}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
