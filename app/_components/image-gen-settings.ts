export type ImageProvider = "openai" | "google";

// Provider + model are browser preferences; the API keys themselves moved to
// encrypted user_settings columns (settings → connections) so server-side
// features can use them too.
export type ImageGenSettings = {
  provider: ImageProvider;
  openaiModel: string;
  googleModel: string;
};

const STORAGE_KEY = "image-gen-settings";

export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettings = {
  provider: "openai",
  openaiModel: "gpt-image-2",
  googleModel: "gemini-3-pro-image-preview",
};

export const OPENAI_MODELS = ["gpt-image-2", "gpt-image-1"];
export const GOOGLE_MODELS = [
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash-image",
];

export function readImageGenSettings(): ImageGenSettings {
  if (typeof window === "undefined") return DEFAULT_IMAGE_GEN_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_IMAGE_GEN_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ImageGenSettings>;
    return { ...DEFAULT_IMAGE_GEN_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_IMAGE_GEN_SETTINGS;
  }
}

export function writeImageGenSettings(settings: ImageGenSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function activeModelFor(settings: ImageGenSettings): string {
  return settings.provider === "openai"
    ? settings.openaiModel
    : settings.googleModel;
}
