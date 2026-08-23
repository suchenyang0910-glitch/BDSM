import assert from "node:assert/strict";
import test from "node:test";
import { isBotReadyToPin } from "../src/scripts/pinMiniAppEntrypoint.js";

test("Mini App pin preflight uses can_edit_messages for channels", () => {
  assert.equal(isBotReadyToPin("channel", {
    isAdministrator: true,
    canPostMessages: true,
    canEditMessages: true,
    canPinMessages: false,
  }), true);
  assert.equal(isBotReadyToPin("channel", {
    isAdministrator: true,
    canPostMessages: true,
    canEditMessages: false,
  }), false);
});

test("Mini App pin preflight keeps can_pin_messages for groups", () => {
  assert.equal(isBotReadyToPin("supergroup", {
    isAdministrator: true,
    canPinMessages: true,
  }), true);
  assert.equal(isBotReadyToPin("supergroup", {
    isAdministrator: true,
    canEditMessages: true,
    canPinMessages: false,
  }), false);
});
