# Languages

The app is in English and Spanish. **English is always the default**, whatever language the phone or browser is set to.

- When setting up an account, the first choice on the form is **Language / Idioma**, with English selected. Picking Español switches the rest of setup (the form, two-factor setup and recovery codes) to Spanish.
- Anyone can change it later under **More > Language**.

The choice is saved on the account, so the server also uses it for:

- the **Today** list (load status buttons, "Next load", "Add the POD", messages);
- **push notifications** drivers get when they reach a stop;
- **turn-by-turn instructions** from the routing server (Valhalla's Spanish).

## What is translated

Spanish covers account setup and what drivers use first: Today, hours of service, driving mode (including the spoken read-out), navigation, documents and scanning, the delivery signature, the Loads filters, the tabs and the More menu. Office screens (dispatch, billing, integrations, insights) are still in English; their text falls back to English automatically.

## Adding a language

Languages are listed once, in `packages/domain/src/languages.ts`. The server's validation, the language pickers, the driving-mode voice and the turn-by-turn locale all read that list. Each language other than English has a dictionary in `packages/workspace/src/locales/`.

1. Start it, giving the code, its own name, its English name, the voice locale and the turn-by-turn locale:

   ```bash
   npm run i18n -- new fr Français French fr-CA fr-FR
   ```

   This writes `locales/fr.ts` with every piece of text and an empty translation, and adds French to the list as a **draft**. Drafts compile and can be tried through the API, but nobody can pick them in the app yet. Anything not translated shows in English.

2. Translate. Fill in the empty values; keep `{braces}` as they are.

3. Check progress:

   ```bash
   npm run i18n                 # every language: required text done, all text done
   npm run i18n -- missing fr   # what French still needs, ready to paste
   ```

   **Required** text is what drivers use and account setup. All of it must be translated before a language ships.

4. Ship it: remove `draft: true` from its line in `languages.ts`. From then on, the tests fail if any required text is missing, so new driver text can't ship untranslated.

The tool finds text by reading the code for `t("...")`, so there is no list of keys to maintain.

## Adding text

Wrap user-facing text in `t()`, written in plain English with values in braces:

```tsx
const t = useT();
<Button title={t("Arrived at pickup")} />
<Text>{t("Next load {n}", { n: load.loadNumber })}</Text>
```

Then run `npm run i18n` to see which languages need it. On the server, `translator(account.language)` does the same. Office screens that still use plain strings stay English in every language until their text is wrapped in `t()`.

API: `language` (any listed code, default `"en"`) on `POST /v1/auth/register`, and `PUT /v1/me/preferences` with `{ "language": "es" }`.
