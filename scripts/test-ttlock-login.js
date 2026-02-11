import dotenv from "dotenv";
dotenv.config({ override: true });
import crypto from "crypto";

const passwordMd5 = crypto
  .createHash("md5")
  .update(process.env.TTLOCK_PASSWORD)
  .digest("hex");

const url = `${process.env.TTLOCK_API_BASE}/oauth2/token`;

const body = new URLSearchParams({
  client_id: process.env.TTLOCK_CLIENT_ID,
  client_secret: process.env.TTLOCK_CLIENT_SECRET,
  username: process.env.TTLOCK_USERNAME,
  password: passwordMd5,
  grant_type: "password",
});

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});

const json = await res.json();
console.log(json);
