# Deployment

## Setup status

The people who run a deployment see **More > Setup status** in the app. List their emails in `LP_ADMIN_EMAILS`. The page shows each outside service, whether it is ready, and the settings that change it:

| Item | Ready when | Settings |
|---|---|---|
| Database | Postgres is configured | `LP_DATABASE_URL` |
| Sign-in sessions | A fixed secret is set, so sessions survive restarts and servers share them | `LP_JWT_SECRET` |
| Stored credentials | ELD keys have their own encryption key | `LP_DATA_KEY` |
| Phone push | Push goes through Expo | `LP_PUSH`, `LP_EXPO_ACCESS_TOKEN` |
| Truck routing | Valhalla answers | `LP_VALHALLA_URL` |
| Address search | Nominatim or Pelias answers | `LP_GEOCODER`, `LP_GEOCODER_URL` |
| Carrier checks | A live FMCSA key is set | `LP_FMCSA_WEBKEY` |
| AS2 certificate | Key and certificate are set, so every server uses the same one | `LP_AS2_KEY_PEM`, `LP_AS2_CERT_PEM` |
| Public address | Not localhost, so partners can reach it | `LP_PUBLIC_URL` |
| Documents | Stored in the database or a directory | `LP_DATABASE_URL`, `LP_FILES_DIR` |

Routing and address search are checked live each time the page opens. The page never shows a secret, only whether one is set. On the phone apps it also says whether the build can receive push. The server logs the same list once at start for anything not ready.

`.env.example` describes every setting.

## Docker

`Dockerfile` builds one image with the API and the website. `deploy/docker-compose.yml` runs it with Postgres, Valhalla and Nominatim:

```bash
cd deploy && LP_JWT_SECRET=$(openssl rand -hex 32) docker compose up -d
```

CI builds the image on every push, starts it against Postgres, signs up an account, checks that the account is in the database and that the website loads.

The compose file uses the Delaware map extract so a first start takes minutes. For the full United States or North America set `MAP_PBF_URL` and see [NAVIGATION.md](NAVIGATION.md) for the machine size it needs.

## Phone apps

The phone apps are built with EAS. `apps/mobile/eas.json` has two profiles: `preview` (installable test builds, an APK on Android) and `production` (store builds, version numbers increase on their own).

Set these as EAS environment variables for each profile before building:

| Variable | What it does |
|---|---|
| `EXPO_PUBLIC_API_URL` | Where the apps reach the API |
| `EAS_PROJECT_ID` | The EAS project. Without it phones can't receive push |
| `EXPO_OWNER` | The Expo account or organization that owns the project |
| `GOOGLE_MAPS_ANDROID_API_KEY` | Maps on Android |

`apps/mobile/app.config.js` reads them at build time.

```bash
cd apps/mobile
npx eas-cli init                         # creates the EAS project; copy its ID into EAS_PROJECT_ID
npx eas-cli build --profile preview      # test builds for phones
npx eas-cli build --profile production   # store builds
npx eas-cli submit --profile production  # send to the App Store and Google Play
```

For push, also upload the Apple push key and the Google service account (FCM) with `npx eas-cli credentials`.
