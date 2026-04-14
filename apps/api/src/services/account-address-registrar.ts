import { getAddress } from "ethers";

export interface AccountAddressRegistrar {
  registerAddress(address: string): Promise<void>;
}

export class AlchemyWebhookAddressRegistrar implements AccountAddressRegistrar {
  constructor(
    private readonly options: {
      authToken: string;
      webhookId: string;
      updateUrl: string;
      fetchFn?: typeof fetch;
    }
  ) {}

  async registerAddress(address: string): Promise<void> {
    const normalizedAddress = getAddress(address);
    const fetchFn = this.options.fetchFn ?? fetch;
    const response = await fetchFn(this.options.updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Alchemy-Token": this.options.authToken
      },
      body: JSON.stringify({
        webhook_id: this.options.webhookId,
        addresses_to_add: [normalizedAddress],
        addresses_to_remove: []
      })
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Alchemy webhook address registration failed with ${response.status}: ${responseText}`
      );
    }
  }
}
