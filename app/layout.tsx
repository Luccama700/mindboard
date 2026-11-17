import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { DockMount } from "./_components/dock-mount";
import { TourMount } from "./_components/onboarding/tour-mount";
import { ThemeInitializer } from "./_components/theme-initializer";
import {
  appleStatusBarStyle,
  getTheme,
  isThemeName,
  type ThemeName,
} from "./_components/themes";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const BASE_METADATA: Metadata = {
  title: "Mindboard",
  description: "Personal life dashboard",
  manifest: "/manifest.webmanifest",
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  // Stops iOS turning dates, times and long numbers in task titles and ledger
  // rows into blue tel:/calendar links.
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

// The status bar style follows the theme (see appleStatusBarStyle). The theme
// is known on the server from the cookie the settings panel mirrors, so the
// next launch of the installed app after a theme change picks the right one.
export async function generateMetadata(): Promise<Metadata> {
  const theme = await cookieTheme();
  return {
    ...BASE_METADATA,
    appleWebApp: {
      capable: true,
      title: "Mindboard",
      statusBarStyle: appleStatusBarStyle(theme),
    },
    other: {
      "apple-mobile-web-app-capable": "yes",
    },
  };
}

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
        <Suspense fallback={null}>
          <DockMount />
        </Suspense>
        <Suspense fallback={null}>
          <TourMount />
        </Suspense>
      </body>
    </html>
  );
}
