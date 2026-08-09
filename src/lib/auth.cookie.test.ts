import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthCookie, buildClearAuthCookie } from "./auth";

type EnvSnapshot = {
  NODE_ENV?: string;
  AUTH_COOKIE_SAME_SITE?: string;
  AUTH_COOKIE_SECURE?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_COOKIE_SAME_SITE: process.env.AUTH_COOKIE_SAME_SITE,
    AUTH_COOKIE_SECURE: process.env.AUTH_COOKIE_SECURE,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setCookieEnv(input: {
  nodeEnv: string;
  sameSite?: string;
  secure?: string;
}) {
  process.env.NODE_ENV = input.nodeEnv;

  if (input.sameSite === undefined) {
    delete process.env.AUTH_COOKIE_SAME_SITE;
  } else {
    process.env.AUTH_COOKIE_SAME_SITE = input.sameSite;
  }

  if (input.secure === undefined) {
    delete process.env.AUTH_COOKIE_SECURE;
  } else {
    process.env.AUTH_COOKIE_SECURE = input.secure;
  }
}

test("keeps staging cookie defaults backward-compatible", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({ nodeEnv: "staging" });

    const authCookie = buildAuthCookie("token");
    const clearCookie = buildClearAuthCookie();

    assert.match(authCookie, /SameSite=Lax/);
    assert.doesNotMatch(authCookie, /(?:^|; )Secure(?:;|$)/);
    assert.match(clearCookie, /SameSite=Lax/);
    assert.doesNotMatch(clearCookie, /(?:^|; )Secure(?:;|$)/);
  } finally {
    restoreEnv(before);
  }
});

test("keeps production cookie defaults unchanged", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({ nodeEnv: "production" });

    const authCookie = buildAuthCookie("token");
    const clearCookie = buildClearAuthCookie();

    assert.match(authCookie, /SameSite=None/);
    assert.match(authCookie, /(?:^|; )Secure(?:;|$)/);
    assert.match(clearCookie, /SameSite=None/);
    assert.match(clearCookie, /(?:^|; )Secure(?:;|$)/);
  } finally {
    restoreEnv(before);
  }
});

test("allows secure cross-site cookies in staging by explicit configuration", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({
      nodeEnv: "staging",
      sameSite: "None",
      secure: "true",
    });

    const authCookie = buildAuthCookie("token");
    const clearCookie = buildClearAuthCookie();

    assert.match(authCookie, /SameSite=None/);
    assert.match(authCookie, /(?:^|; )Secure(?:;|$)/);
    assert.match(clearCookie, /SameSite=None/);
    assert.match(clearCookie, /(?:^|; )Secure(?:;|$)/);
  } finally {
    restoreEnv(before);
  }
});

test("rejects SameSite=None when Secure is disabled", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({
      nodeEnv: "staging",
      sameSite: "None",
      secure: "false",
    });

    assert.throws(
      () => buildAuthCookie("token"),
      /AUTH_COOKIE_SAME_SITE_NONE_REQUIRES_SECURE/
    );
    assert.throws(
      () => buildClearAuthCookie(),
      /AUTH_COOKIE_SAME_SITE_NONE_REQUIRES_SECURE/
    );
  } finally {
    restoreEnv(before);
  }
});

test("rejects invalid SameSite configuration", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({
      nodeEnv: "staging",
      sameSite: "CrossSite",
      secure: "true",
    });

    assert.throws(
      () => buildAuthCookie("token"),
      /AUTH_COOKIE_SAME_SITE_INVALID/
    );
  } finally {
    restoreEnv(before);
  }
});

test("rejects invalid Secure configuration", () => {
  const before = snapshotEnv();

  try {
    setCookieEnv({
      nodeEnv: "staging",
      sameSite: "Lax",
      secure: "yes",
    });

    assert.throws(
      () => buildAuthCookie("token"),
      /AUTH_COOKIE_SECURE_INVALID/
    );
  } finally {
    restoreEnv(before);
  }
});
