import { describe, expect, it, vi } from "vitest";

import { AlchemyWebhookAddressRegistrar } from "../src/services/account-address-registrar";

describe("Alchemy webhook address registrar", () => {
  it("sends an idempotent update-webhook-addresses request", async () => {
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;
    const registrar = new AlchemyWebhookAddressRegistrar({
      authToken: "notify-token",
      webhookId: "wh_test",
      updateUrl: "https://dashboard.alchemy.com/api/update-webhook-addresses",
      fetchFn
    });

    await registrar.registerAddress("0xbe3f4b43db5eb49d1f48f53443b9abce45da3b79");

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(
      "https://dashboard.alchemy.com/api/update-webhook-addresses",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Alchemy-Token": "notify-token"
        },
        body: JSON.stringify({
          webhook_id: "wh_test",
          addresses_to_add: ["0xBe3f4B43dB5EB49D1f48f53443B9AbCe45Da3b79"],
          addresses_to_remove: []
        })
      }
    );
  });

  it("fails when Alchemy returns a non-success response", async () => {
    const fetchFn = vi.fn(
      async () => new Response("bad request", { status: 400 })
    ) as unknown as typeof fetch;
    const registrar = new AlchemyWebhookAddressRegistrar({
      authToken: "notify-token",
      webhookId: "wh_test",
      updateUrl: "https://dashboard.alchemy.com/api/update-webhook-addresses",
      fetchFn
    });

    await expect(
      registrar.registerAddress("0xbe3f4b43db5eb49d1f48f53443b9abce45da3b79")
    ).rejects.toThrow(
      "Alchemy webhook address registration failed with 400: bad request"
    );
  });
});
