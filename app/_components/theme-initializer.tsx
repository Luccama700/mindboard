"use client";

import { useEffect } from "react";
import { readStoredTheme, setActiveTheme } from "./themes";

export function ThemeInitializer() {
  useEffect(() => {
    setActiveTheme(readStoredTheme());
  }, []);

  return null;
}
