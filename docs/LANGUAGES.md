# Languages

The app is in English and Spanish. Each person picks a language under **More > Language**; until they do, the app follows the phone's or browser's language. The choice is saved on the account, so the server also uses it for:

- the **Today** list (load status buttons, "Next load", "Add the POD", messages);
- **push notifications** drivers get when they reach a stop;
- **turn-by-turn instructions** from the routing server (Valhalla's Spanish).

## What is translated

Spanish covers what drivers use first: Today, hours of service, driving mode (including the spoken read-out), navigation, documents and scanning, the delivery signature, the Loads filters, the tabs and the More menu. Office screens (dispatch, billing, integrations, insights) are still in English; their text falls back to English automatically.

A test (`packages/workspace/test/i18n.test.ts`) reads the driver screens and fails if any text on them has no Spanish translation.

## Adding text

Wrap user-facing text in `t()`, written in plain English with values in braces:

```tsx
const t = useT();
<Button title={t("Arrived at pickup")} />
<Text>{t("Next load {n}", { n: load.loadNumber })}</Text>
```

Then add the Spanish to `packages/workspace/src/i18n.es.ts`. On the server, `translator(account.language)` does the same.

API: `PUT /v1/me/preferences` with `{ "language": "es" }`.
