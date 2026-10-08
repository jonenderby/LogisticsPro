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

## Admin and test accounts

The people in `LP_ADMIN_EMAILS` (in `deploy/.env`, comma-separated) see **More > Admin**. Nobody else sees it, and the server refuses its requests from anyone else.

- **Test accounts.** Make a trucker, carrier, 3PL or business, with its company, and a trucker who drives for one of your test carriers. Tap one to use the app as that account. A bar across the top says whose app you are looking at and takes you back to your own. Nobody can sign in to a test account with a password; they exist only to be switched into.
- **Real people.** Add someone with their email. You get a one-time password to give them; on first sign-in they set up two-factor themselves.
- **Everyone and every company** on the server, with their companies and roles.

Switching works only for test accounts, never for a real person's account, and only while you are still in `LP_ADMIN_EMAILS`. The server logs each switch.

After changing `LP_ADMIN_EMAILS`, restart the app with `cd deploy && docker compose up -d`, then sign out and back in.

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
- The privacy policy is at `https://lp.example.com/privacy`, in English or Spanish. The app links to it from More.

| File | What it does |
|---|---|
| `deploy/setup.sh` | Writes `deploy/.env` once with the address, your email and new secrets. It never overwrites an existing one. |
| `deploy/docker-compose.yml` | Runs Caddy, the API, Postgres, Valhalla and Nominatim. Only Caddy, or your own web server, is reachable from outside. All of them restart after a reboot. |
| `deploy/build-android.sh` | Builds the Android app in Docker, signs it with this server's own key and puts it on the download page. Needs only Docker. |
| `deploy/publish-play.sh` | Sends the latest build to Google Play testers. See below. |
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

### Sharing a domain with another site (nginx, Pterodactyl)

When another web server already has ports 80 and 443, Logistics Pro can live under a path on that domain, such as `https://jonnysserver.com/logistics`. Caddy stays off and your web server passes the path on to the app:

```bash
deploy/setup.sh jonnysserver.com/logistics you@example.com --nginx
cd deploy && docker compose up -d --build
```

`--nginx` leaves Caddy out, has the app listen on `127.0.0.1:8090` (Pterodactyl's Wings usually has 8080), and writes `deploy/nginx-logistics.conf`. Paste its lines into the `server` block for your domain that listens on 443. For Pterodactyl that is `/etc/nginx/sites-available/pterodactyl.conf`. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The block starts with `location ^~ /logistics/`. The `^~` matters: without it the panel's PHP rule can catch some addresses. The app takes care of the path itself: the website's files, links, sign-in cookies, the download page and the addresses given to partners all include it.

### Production and test on one server

A test site can run next to production, for example `https://jonnysserver.com/logistics` from the `main` branch and `https://jonnysserver.com/logistics-test` from a `test` branch. Each is its own clone with its own `deploy/.env`, port and database, so test data never mixes with real data.

```bash
git clone https://github.com/jonenderby/LogisticsPro LogisticsPro-test && cd LogisticsPro-test
git checkout test
deploy/setup.sh jonnysserver.com/logistics-test you@example.com --nginx --port 8091
cd deploy && docker compose up -d --build
```

Then paste the lines from this clone's `deploy/nginx-logistics.conf` into the same nginx `server` block as production's, next to the `/logistics/` block, and reload nginx.

- Setup gives each copy its own `COMPOSE_PROJECT_NAME`, which Docker uses to keep containers and data apart. Don't change it once a copy is running: a new name starts with an empty database. A copy set up before this setting existed is named after its folder (`deploy`); leave it that way.
- To try a change: push it to `test`, then in the test clone `git pull && cd deploy && docker compose up -d --build`. When it is right, merge `test` into `main` and do the same in the production clone.
- Each copy runs its own map servers. That is fine with a state extract; with the whole country, give the test copy a small extract (`MAP_PBF_URL`) so the two don't need twice the memory.
- A phone holds one Logistics Pro app at a time. Build the test copy's app (`deploy/build-android.sh` in the test clone) for test phones only.

### Changing the address later

`LP_PUBLIC_URL` in `deploy/.env` is the one address everything follows, with or without a path. To move to a new address, such as `https://app.yourcompany.com`:

1. Point the new domain at the server and give it HTTPS: a new nginx `server` block with a `location /` like the one in `deploy/nginx-logistics.conf`, or Caddy with `LP_DOMAIN` and `COMPOSE_PROFILES=caddy`.
2. Set `LP_PUBLIC_URL` (and `LP_DOMAIN`) to the new address.
3. `cd deploy && docker compose up -d --build`, so the website is rebuilt for it.
4. `deploy/build-android.sh` (and `deploy/publish-play.sh`), since the phone app has the address built in.

Keep the old address passing requests to the app until everyone has the new phone app; the server answers on both. Tell EDI and AS2 partners the new address, since they send to it.

## Google Play private beta

Google Play's **internal testing** track gives the app to up to 100 people you invite by email. It never appears in Play Store search, and new builds reach testers within minutes. `deploy/build-android.sh` already makes the file Play needs, `deploy/play/logistics-pro.aab`, signed with this server's key.

**One time, in Play Console**

1. Make a Google Play developer account at play.google.com/console. It costs $25 once. Use an organization account if you will later publish to everyone; personal accounts must first run a closed test with 12 testers for 14 days.
2. **Create app**: name it Logistics Pro, choose App and Free.
3. **Testing > Internal testing > Testers**: make an email list of your testers' Google accounts.
4. **Create new release**. Let Google manage the app signing key, then upload `deploy/play/logistics-pro.aab` (copy it off the server with `scp`). This server's key becomes the *upload key*; Play may ask for `deploy/play/upload-certificate.pem`.
5. **App content**: enter the privacy policy address, `https://<your domain>/privacy`. Set `LP_OPERATOR_NAME` in `deploy/.env` to your company's legal name first, and read the policy over. Fill in the other forms Play lists: ads (none), content rating, target audience (18 and over), and the declarations for location in the background and the location foreground service. Play shows which ones it needs before each kind of release.
6. Copy the **opt-in link** from the Testers tab and send it to your testers. They open it on their phone, accept, and install Logistics Pro from the Play Store.

The package name, `com.logisticspro.app`, is fixed by the first upload and can never change. If Play says it is taken, change `package` in `apps/mobile/app.json` before uploading.

**Every build after that, from the server**

1. In Google Cloud Console, make a project, turn on the **Google Play Android Developer API**, create a service account and download a JSON key for it.
2. In Play Console > **Users and permissions**, invite the service account's email and give it **Release to testing tracks** for this app.
3. Save the key on the server as `deploy/play-service-account.json` with `chmod 600`.

Then each new build is:

```bash
deploy/build-android.sh
deploy/publish-play.sh "What changed in this build"
```

`LP_PLAY_TRACK` in `deploy/.env` picks another track: `alpha` is closed testing, `beta` is open testing.

**Good to know**

- Builds installed from Play are signed by Google, and the APK on `/download` by this server, so a phone can't switch between the two without uninstalling first. Give each tester one or the other.
- If the upload key in `deploy/android-keys` is lost, Play support can register a new one; the app itself keeps working. `deploy/backup.sh` copies it.
- Before going beyond internal testing, Play also wants the Data safety form and a way to delete an account from inside the app. The privacy policy currently asks people to email for deletion.

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
