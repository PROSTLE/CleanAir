// Locale routing removed — language switching handled client-side via LanguageContext
export const locales = ['en', 'hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'or', 'as'];

export default function middleware() {
  // No-op: locale routing is handled client-side via LanguageContext
}

export const config = {
  matcher: [],
};
