import assert from "node:assert/strict";
import test from "node:test";
import { flashCopy, resolveFlashLocale } from "./flash-copy.js";

test("flash copy selects Italian and substitutes message values", () => {
  assert.equal(resolveFlashLocale("it"), "it");
  assert.equal(
    flashCopy("it-IT", "joinedBody", { id: 42, massTs: 1_798_328_400 }),
    "Massa flash **#42** — ci vediamo alla mass <t:1798328400:t>.",
  );
});

test("unsupported Discord locales use English copy", () => {
  assert.equal(resolveFlashLocale("fr"), "en");
  assert.equal(flashCopy("fr", "join"), "Join");
});
