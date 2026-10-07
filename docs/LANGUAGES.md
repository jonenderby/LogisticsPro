# Languages

The app is in English and Spanish. **English is always the default**, whatever language the phone or browser is set to.

- When setting up an account, the first choice on the form is **Language / Idioma**, with English selected. Picking Español switches the rest of setup (the form, two-factor setup and recovery codes) to Spanish.
- Anyone can change it later under **More > Language**.

The choice is saved on the account, so the server also uses it for:

- the **Today** list (load status buttons, "Next load", "Add the POD", messages);
- **push notifications** drivers get when they reach a stop;
- **turn-by-turn instructions** from the routing server (Valhalla's Spanish).

## What is translated

Spanish covers every screen: account setup, everything drivers use (Today, hours of service, driving mode with the spoken read-out, navigation, documents, the delivery signature) and the office screens (load details, dispatch, tracking, the load board, money and invoices, rate confirmations, carrier checks, fuel tax, ELD, integrations, insights, alerts, notifications, business and network settings). Screen titles, status words and button groups are translated too.

Some things stay as they are in every language: company, place and people names, notes people type, the standard clauses on a rate confirmation (the signed agreement is in English), and explanations the server writes, such as ETA reasons, carrier-check details and error messages.

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

4. Ship it: remove `draft: true` from its line in `languages.ts`. From then on, the tests fail if any required text is missing, so new driver text can't ship untranslated. Office text can follow later; until then it shows in English.

Spanish has a stricter test: every piece of text in the app must be translated, so a new screen can't ship in English only.

The tool finds text by reading the code for `t("...")`, `tx("...")` and status words from the domain, so there is no list of keys to maintain.

## Adding text

Wrap user-facing text in `t()`, written in plain English with values in braces:

```tsx
const t = useT();
<Button title={t("Arrived at pickup")} />
<Text>{t("Next load {n}", { n: load.loadNumber })}</Text>
```

Then run `npm run i18n` to see which languages need it, and add the Spanish to `locales/es.ts`. On the server, `translator(account.language)` does the same.

A few helpers keep this short:

- Text in a lookup table outside a component is marked with `tx("...")`, which does nothing at runtime but lets the tool find it. Translate it where it is shown: `t(STATUS[s].label)`.
- `Chip` and `Segmented` translate their labels themselves, and `StatusPill` shows any status code as translated words.
- For a status code from the domain, `t(titleCase(code))` shows it as words. The tool picks up every domain status automatically.
- Helpers outside components take the translator as an argument, for example `ago(iso, t)`, `etaLine(eta, t)` and `visitLine(stop, t)`.

API: `language` (any listed code, default `"en"`) on `POST /v1/auth/register`, and `PUT /v1/me/preferences` with `{ "language": "es" }`.
