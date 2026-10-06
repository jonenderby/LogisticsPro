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

A test (`packages/workspace/test/i18n.test.ts`) reads the driver screens and fails if any text on them has no Spanish translation.

## Adding text

Wrap user-facing text in `t()`, written in plain English with values in braces:

```tsx
const t = useT();
<Button title={t("Arrived at pickup")} />
<Text>{t("Next load {n}", { n: load.loadNumber })}</Text>
```

Then add the Spanish to `packages/workspace/src/i18n.es.ts`. On the server, `translator(account.language)` does the same.

API: `language` (`"en"` or `"es"`, default `"en"`) on `POST /v1/auth/register`, and `PUT /v1/me/preferences` with `{ "language": "es" }`.
