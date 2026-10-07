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
| Live traffic | A HERE or TomTom key is set | `LP_TRAFFIC`, `LP_TRAFFIC_KEY` |
| Address search | Nominatim or Pelias answers | `LP_GEOCODER`, `LP_GEOCODER_URL` |
| Carrier checks | A live FMCSA key is set | `LP_FMCSA_WEBKEY` |
| AS2 certificate | Key and certificate are set, so every server uses the same one | `LP_AS2_KEY_PEM`, `LP_AS2_CERT_PEM` |
| Public address | Not localhost, so partners can reach it | `LP_PUBLIC_URL` |
| Documents | Stored in the database or a directory | `LP_DATABASE_URL`, `LP_FILES_DIR` |

Routing and address search are checked live each time the page opens. The page never shows a secret, only whether one is set. On the phone apps it also says whether the build can receive push. The server logs the same list once at start for anything not ready.

`.env.example` describes every setting.

## Your own server

Everything runs on one server you control: the API and website, the database, documents, truck routing, address search, HTTPS and the phone app download. You need Docker, a domain name pointed at the server, and ports 80 and 443 open.

```bash
git clone https://github.com/jonenderby/LogisticsPro && cd LogisticsPro
deploy/setup.sh lp.example.com you@example.com   # once: writes deploy/.env with fresh secrets
cd deploy && docker compose up -d --build         # starts everything
cd .. && deploy/build-android.sh                  # builds the Android app on the server
```

Then:

- The website is at `https://lp.example.com`. Caddy gets the HTTPS certificate on its own.
- Phones install the app from `https://lp.example.com/download`.
- The email you gave sees **More > Setup status**.

| File | What it does |
|---|---|
| `deploy/setup.sh` | Writes `deploy/.env` once with the domain, your email and new secrets. It never overwrites an existing one. |
| `deploy/docker-compose.yml` | Runs Caddy, the API, Postgres, Valhalla and Nominatim. Only Caddy is reachable from outside. All of them restart after a reboot. |
| `deploy/build-android.sh` | Builds the Android app in Docker, signs it with this server's own key and puts it on the download page. Needs only Docker. |
| `deploy/backup.sh` | Backs up the database, the AS2 certificate, the Android signing key and `deploy/.env` into `deploy/backups`. |

**Keep these safe.** `deploy/.env` and `deploy/android-keys` hold the secrets. Without `.env` nobody can sign in and stored ELD keys can't be read. Without the signing key, phones must uninstall the app before they can install a newer build. `deploy/backup.sh` copies both; copy `deploy/backups` off the server too.

**Updating.** `git pull`, then `cd deploy && docker compose up -d --build` for the server and `deploy/build-android.sh` for the phone app. Phones install the new build over the old one from the download page.

**What still leaves the server.** Map data is downloaded from Geofabrik on first start, and Caddy asks Let's Encrypt for the certificate. Nothing else goes out unless you turn it on:

| Turned on by | Sends to |
|---|---|
| `LP_PUSH=expo` | Expo's push service, for phone notifications. Off by default here, so notifications stay in the app's list. |
| `LP_FMCSA_WEBKEY` | FMCSA, to check carriers. |
| `LP_TRAFFIC_KEY` | HERE or TomTom, for live traffic. |
| An ELD connection | Motive, Samsara or Geotab, when a carrier connects one. |

**iPhones.** Apple only lets iPhone apps be built on a Mac with Xcode, and installs need an Apple Developer account. Build an ad hoc `.ipa` there for the iPhones you register, copy it to `deploy/downloads/logistics-pro.ipa`, and the download page offers it. Until then iPhone users can use the website.

## Docker

`Dockerfile` builds one image with the API and the website. `deploy/docker-compose.yml` runs it with Caddy, Postgres, Valhalla and Nominatim, as described above. To try it on your own machine without a domain, skip `setup.sh`; it runs at `https://localhost` with a certificate only that machine trusts:

```bash
cd deploy && LP_JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

CI builds the image on every push, starts it against Postgres, signs up an account, checks that the account is in the database and that the website loads. It also runs `deploy/build-android.sh` whenever the app or the deploy files change, and checks that the APK is signed and installs over older builds.

The compose file uses the Delaware map extract so a first start takes minutes. For the full United States or North America set `MAP_PBF_URL` in `deploy/.env` and see [NAVIGATION.md](NAVIGATION.md) for the machine size it needs.

## Phone apps through Expo's cloud

Instead of building on your own server, the phone apps can be built with EAS, which is also how they go to the App Store and Google Play. `apps/mobile/eas.json` has two profiles: `preview` (installable test builds, an APK on Android) and `production` (store builds, version numbers increase on their own).

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
