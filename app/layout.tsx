import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { ThemeInitializer } from "./_components/theme-initializer";
import { getTheme, isThemeName, type ThemeName } from "./_components/themes";
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

async function cookieTheme(): Promise<ThemeName> {
  const store = await cookies();
  const value = store.get("theme")?.value;
  return isThemeName(value) ? value : "dark";
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await cookieTheme();
  return {
    themeColor: getTheme(theme).palette.bg,
    viewportFit: "cover",
    width: "device-width",
    initialScale: 1,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = await cookieTheme();
  const themeClass = theme === "dark" ? "" : ` theme-${theme}`;

  return (
    <html lang="en" className={`${geistMono.variable} h-full${themeClass}`}>
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeInitializer />
        {children}
      </body>
    </html>
  );
}
