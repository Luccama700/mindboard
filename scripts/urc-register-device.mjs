#!/usr/bin/env node
// Register this PC as a URC device and print its token once.
//
//   node scripts/urc-register-device.mjs --user <supabase-user-uuid> --name "home-pc"
//
// Rotate an existing device's token in place (the old token stops working the
// moment this runs; paste the new one into worker/urc.env and restart the agent):
//
//   node scripts/urc-register-device.mjs --user <supabase-user-uuid> --rotate <device-uuid>
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local
// (same loader shape as test/isolation-proof.mjs) and writes one urc_devices
// row holding only the SHA-256 hash of the token. The plaintext token is shown
// exactly once, here - paste it into worker/urc.env as URC_DEVICE_TOKEN and
// nowhere else. It is NOT an MCP token: it only works on POST /api/urc/device
// and can do nothing but heartbeat and move that one device's own jobs.
//
// Requires migration 0054_urc.sql to be applied first.

import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const userId = argValue("--user");
const name = argValue("--name");
const rotateId = argValue("--rotate");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!userId || !UUID.test(userId) || (!name && !rotateId) || (rotateId && !UUID.test(rotateId))) {
  console.error(
    [
      "usage:",
      '  node scripts/urc-register-device.mjs --user <supabase-user-uuid> --name "home-pc"',
      "  node scripts/urc-register-device.mjs --user <supabase-user-uuid> --rotate <device-uuid>",
    ].join("\n"),
  );
  process.exit(1);
}

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const token = `urcd_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = rotateId
  ? await admin
      .from("urc_devices")
      .update({ token_hash: tokenHash })
      .eq("id", rotateId)
      .eq("user_id", userId)
      .select("id, name, created_at")
      .single()
  : await admin
      .from("urc_devices")
      .insert({ user_id: userId, name, token_hash: tokenHash })
      .select("id, name, created_at")
      .single();

if (error) {
  console.error(
    rotateId
      ? `could not rotate the device token (is ${rotateId} this user's device?): ${error.message}`
      : `could not register the device: ${error.message}`,
  );
  process.exit(1);
}

console.log(
  rotateId
    ? `rotated the token for device ${data.name} (${data.id}); the old token no longer works`
    : `registered device ${data.name} (${data.id}) for user ${userId}`,
);
console.log("");
console.log("URC_DEVICE_TOKEN (shown once - paste into worker/urc.env):");
console.log("");
console.log(`  ${token}`);
console.log("");
console.log("Next: fill in worker/urc.env + worker/urc.folders.json, then start the agent");
console.log("(worker/run-urc-agent.cmd). See worker/URC.md.");
