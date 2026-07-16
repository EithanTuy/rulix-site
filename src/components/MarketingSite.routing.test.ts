import { describe, expect, it } from "vitest";
import { marketingAccessRequestEndpoint } from "./MarketingSite";

describe("marketing access-request routing", () => {
  it.each(["rulix.cloud", "www.rulix.cloud", " RULIX.CLOUD "])(
    "routes the Netlify host %s to the production app API",
    (hostname) => {
      expect(marketingAccessRequestEndpoint(hostname)).toBe(
        "https://app.rulix.cloud/api/access-requests"
      );
    }
  );

  it.each(["app.rulix.cloud", "dashboard.rulix.cloud", "127.0.0.1", "localhost"])(
    "keeps the app host %s on its same-origin API",
    (hostname) => {
      expect(marketingAccessRequestEndpoint(hostname)).toBe("/api/access-requests");
    }
  );
});
