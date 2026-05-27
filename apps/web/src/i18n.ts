import i18n, { type TOptions } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { useSettings } from './useSettings';
import en from './locales/en.json';
import es from './locales/es.json';

export type Lang = 'en' | 'es';
export const LANGS: Lang[] = ['en', 'es'];

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

// Type augmentation: keys autocomplete on `t('…')` thanks to the JSON shape.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}

/** Hook de traducción. Mantiene `prefs.lang` sincronizado con i18next. */
export function useT() {
  const { prefs } = useSettings();
  const { t } = useTranslation();
  useEffect(() => {
    if (i18n.language !== prefs.lang) void i18n.changeLanguage(prefs.lang);
  }, [prefs.lang]);
  // Typed-string wrapper: we accept a plain string so callers can build keys at
  // runtime (e.g. `settings.tab.${id}`). i18next's strict literal typing trips
  // on the broader union, so we cast to `never` to opt out — the keys still
  // resolve correctly at runtime, just without compile-time autocomplete here.
  return (key: string, opts?: TOptions) =>
    (t as (k: never, o?: TOptions) => string)(key as never, opts);
}
