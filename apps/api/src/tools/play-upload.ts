/**
 * Upload the app bundle to Google Play. Run through deploy/publish-play.sh:
 *
 *   tsx apps/api/src/tools/play-upload.ts --key <service account json> --bundle <aab> [--track internal] [--notes "..."]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PlayError, type ServiceAccount, publishBundle } from "../services/googlePlay.js";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    bundle: { type: "string" },
    package: { type: "string", default: "com.logisticspro.app" },
    track: { type: "string", default: "internal" },
    notes: { type: "string" },
  },
});
if (!values.key || !values.bundle) {
  console.error("Usage: play-upload --key <service account json> --bundle <aab> [--track internal] [--notes text]");
  process.exit(2);
}

try {
  const result = await publishBundle({
    account: JSON.parse(readFileSync(values.key, "utf8")) as ServiceAccount,
    packageName: values.package!,
    bundle: readFileSync(values.bundle),
    track: values.track!,
    notes: values.notes,
  });
  console.log(`Uploaded build ${result.versionCode} to the ${result.track} track.`);
  if (result.status === "draft") console.log("The app isn't fully set up in Play Console yet, so the release is a draft. Roll it out from Testing > Internal testing.");
  else console.log("Testers get it from Google Play within a few minutes.");
} catch (e) {
  console.error(e instanceof PlayError ? e.message : e);
  process.exit(1);
}
