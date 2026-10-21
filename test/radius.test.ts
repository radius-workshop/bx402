import { afterEach, describe, expect, it, vi } from "vitest";
import type { X402Config } from "../src/config.js";
import { guideFacts } from "../src/discovery.js";
import { failure, Metrics } from "../src/metrics.js";
import { accepts, challenge, client, handle, offers, start } from "../src/x402.js";
import {
  assertRecorded,
  buildContext,
  decodeChallenge,
  mockFacilitatorSupport,
  mockOrigin,
  mockRadiusSupport,
  RADIUS_MAINNET_FACILITATOR,
  RADIUS_TESTNET_FACILITATOR,
  restoreNetwork,
  SETTLED,
  TEST_FACILITATOR,
  testConfig,
} from "./support.js";

const RADIUS_TESTNET = "eip155:72344";
const RADIUS_MAINNET = "eip155:723487";

/** SBC, deployed at one address on both Radius networks. */
const SBC = "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb";

const PATH = "/res/v1/web/search";
const REQUESTED = `https://bx402.example.com${PATH}?q=rust`;

/** The x402 rail's settings with Radius turned on. */
const RADIUS_ON: X402Config = {
  facilitatorUrl: TEST_FACILITATOR,
  cdp: undefined,
  enableBazaar: true,
  enableRadius: true,
};

/** The offer a deployment advertises for the search path on `network`. */
function offerOn(network: string, enableRadius = true) {
  const offer = accepts(true, enableRadius)
    .get(PATH)
    ?.find((entry) => entry.network === network);
  if (offer === undefined) {
    throw new Error(`no offer on ${network}`);
  }
  return offer;
}

/** Headers for a payment accepting `offer`, carrying a well-formed eip3009 authorization. */
function payment(offer: unknown): Headers {
  const payload = {
    x402Version: 2,
    accepted: offer,
    payload: {
      authorization: { from: `0x${"AB".repeat(20)}`, nonce: `0x${"CD".repeat(32)}` },
      signature: "0x",
    },
  };
  return new Headers({
    "payment-signature": Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  });
}

/** The Brave Search answer every paid request in these tests gets. */
const SEARCH_RESULT = () => new Response(JSON.stringify({ web: {} }), { status: 200 });

/**
 * Record the body of every facilitator call the rail makes, by path, while the
 * call itself still goes out over the mock network. The mock hands its own stubs
 * the body as a stream, so the record is taken where the SDK's client sends it.
 */
function recordFacilitatorBodies(): Record<string, unknown[]> {
  const bodies: Record<string, unknown[]> = {};
  const send = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (typeof init?.body === "string") {
      bodies[path] = [...(bodies[path] ?? []), JSON.parse(init.body)];
    }
    return send(input, init);
  });
  return bodies;
}

describe("radius", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreNetwork();
  });

  it("radius_is_offered_only_when_it_is_turned_on", () => {
    const networks = (allowTestnet: boolean, enableRadius?: boolean) =>
      accepts(allowTestnet, enableRadius)
        .get(PATH)
        ?.map((entry) => entry.network);

    // Off unless asked for, so a deployment that never opted in is unchanged.
    expect(networks(true)).toEqual(["eip155:84532", "eip155:8453"]);
    expect(networks(false)).toEqual(["eip155:8453"]);
    expect(networks(true, false)).toEqual(["eip155:84532", "eip155:8453"]);

    // Testnets lead, as they do without Radius, so a client taking the first offer
    // it supports pays with faucet money.
    expect(networks(true, true)).toEqual([
      "eip155:84532",
      RADIUS_TESTNET,
      "eip155:8453",
      RADIUS_MAINNET,
    ]);
    expect(networks(false, true)).toEqual(["eip155:8453", RADIUS_MAINNET]);
  });

  it("the_radius_offer_is_an_eip3009_transfer_of_sbc_at_the_same_price", () => {
    // Every field is spelled out so a change to the SDK's network table fails here
    // instead of silently moving the charge.
    for (const network of [RADIUS_TESTNET, RADIUS_MAINNET]) {
      expect(offerOn(network)).toEqual({
        scheme: "exact",
        network,
        amount: "5000",
        asset: SBC,
        payTo: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
        maxTimeoutSeconds: 300,
        // The EIP-712 domain the payer signs under: the token's own name, not "SBC".
        extra: { assetTransferMethod: "eip3009", name: "Stable Coin", version: "1" },
      });
    }
  });

  it("every_sold_path_is_offered_on_radius_at_its_own_price", () => {
    for (const [path, entries] of accepts(true, true)) {
      const prices = entries.filter((entry) => entry.asset === SBC).map((entry) => entry.amount);
      expect(prices, path).toHaveLength(2);
      const base = entries.find((entry) => entry.network === "eip155:8453");
      expect(prices, path).toEqual([base?.amount, base?.amount]);
    }
  });

  it("the_cold_challenge_and_discovery_name_the_radius_offers", () => {
    const built = client(RADIUS_ON, true);
    const entry = challenge(built, REQUESTED, "GET");
    const { accepts: advertised } = decodeChallenge((entry as { value: string }).value) as {
      accepts: { network: string }[];
    };
    expect(advertised.map((offer) => offer.network)).toEqual([
      "eip155:84532",
      RADIUS_TESTNET,
      "eip155:8453",
      RADIUS_MAINNET,
    ]);

    // The discovery document has no network field, so the sentence is the only
    // place a reader learns which chain an SBC offer settles on.
    const described = offers(built, PATH);
    expect(described.map((offer) => offer.description)).toEqual([
      "USDC on Base Sepolia (testnet)",
      "SBC on Radius Test Network (testnet)",
      "USDC on Base",
      "SBC on Radius Network",
    ]);
    expect(described.filter((offer) => offer.currency === SBC)).toHaveLength(2);
  });

  it("the_guide_facts_say_radius_only_where_the_deployment_sells_on_it", async () => {
    // The MPP rail is left out: it refuses a testnet chain without the testnet flag,
    // and these deployments differ only in what the x402 rail offers.
    const facts = async (x402: X402Config, allowTestnet: boolean) => {
      const built = guideFacts(
        await buildContext(testConfig({ x402, allowTestnet, mpp: undefined })),
      );
      restoreNetwork();
      return built;
    };
    expect(await facts({ ...RADIUS_ON, enableRadius: false }, true)).toMatchObject({
      radius: false,
      radiustestnet: false,
    });
    expect(await facts(RADIUS_ON, true)).toMatchObject({ radius: true, radiustestnet: true });
    expect(await facts(RADIUS_ON, false)).toMatchObject({ radius: true, radiustestnet: false });
  });

  it("a_payment_on_radius_is_verified_searched_then_settled_by_the_radius_facilitator", async () => {
    // The Base facilitator has no verify or settle stub, so a payment that reached
    // it would fail the test. The order matters too: a charge for a failed search
    // is what verifying first is for.
    mockFacilitatorSupport();
    mockRadiusSupport();
    const calls: string[] = [];
    const bodies = recordFacilitatorBodies();
    const pool = mockOrigin(RADIUS_TESTNET_FACILITATOR);
    pool.intercept({ method: "POST", path: "/verify" }).reply(200, () => {
      calls.push("verify");
      return { isValid: true, payer: `0x${"AB".repeat(20)}` };
    });
    pool.intercept({ method: "POST", path: "/settle" }).reply(200, () => {
      calls.push("settle");
      return { ...SETTLED, network: RADIUS_TESTNET, transaction: `0x${"12".repeat(32)}` };
    });

    const built = await start(RADIUS_ON, true);
    const metrics = new Metrics();
    const response = await handle(
      built,
      undefined,
      metrics,
      PATH,
      REQUESTED,
      payment(offerOn(RADIUS_TESTNET)),
      async () => {
        calls.push("search");
        return SEARCH_RESULT();
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "search", "settle"]);
    // Both facilitator calls state the offer the payer accepted, on Radius.
    for (const path of ["/verify", "/settle"]) {
      expect(bodies[path], path).toHaveLength(1);
      expect(bodies[path]?.[0], path).toMatchObject({
        paymentRequirements: { network: RADIUS_TESTNET, asset: SBC, amount: "5000" },
      });
    }
    const receipt = JSON.parse(
      Buffer.from(response.headers.get("payment-response") ?? "", "base64").toString("utf8"),
    );
    expect(receipt).toMatchObject({
      success: true,
      network: RADIUS_TESTNET,
      transaction: `0x${"12".repeat(32)}`,
    });
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="x402",endpoint="${PATH}",outcome="settled"} 1`,
    );
    // What is counted as earned is the advertised price, in the asset it was paid in.
    await assertRecorded(
      metrics,
      `bx402_charged_base_units_total{rail="x402",endpoint="${PATH}",asset="SBC on Radius Test Network (testnet)"} 5000`,
    );
  });

  it("a_payment_on_radius_mainnet_goes_to_the_mainnet_facilitator", async () => {
    mockFacilitatorSupport();
    mockRadiusSupport();
    const pool = mockOrigin(RADIUS_MAINNET_FACILITATOR);
    pool.intercept({ method: "POST", path: "/verify" }).reply(200, { isValid: true });
    pool
      .intercept({ method: "POST", path: "/settle" })
      .reply(200, { ...SETTLED, network: RADIUS_MAINNET });

    const built = await start(RADIUS_ON, true);
    const response = await handle(
      built,
      undefined,
      new Metrics(),
      PATH,
      REQUESTED,
      payment(offerOn(RADIUS_MAINNET)),
      async () => SEARCH_RESULT(),
    );
    expect(response.status).toBe(200);
  });

  it("a_radius_facilitator_refusal_is_a_402_and_an_outage_is_a_502", async () => {
    // A refusal is the facilitator's own verdict, which the rail reads off the
    // error class. That only works when the SDK and the rail share one copy of
    // @x402/core, so this is the standing check that the install keeps it that way.
    const verifyAnswering = async (statusCode: number, data: object) => {
      mockFacilitatorSupport();
      mockRadiusSupport();
      mockOrigin(RADIUS_TESTNET_FACILITATOR)
        .intercept({ method: "POST", path: "/verify" })
        .reply(statusCode, data);
      const built = await start(RADIUS_ON, true);
      const metrics = new Metrics();
      let searched = false;
      const response = await handle(
        built,
        undefined,
        metrics,
        PATH,
        REQUESTED,
        payment(offerOn(RADIUS_TESTNET)),
        async () => {
          searched = true;
          return SEARCH_RESULT();
        },
      );
      restoreNetwork();
      return { response, metrics, searched };
    };

    const refused = await verifyAnswering(400, {
      isValid: false,
      invalidReason: "invalid_exact_evm_insufficient_balance",
    });
    expect(refused.response.status).toBe(402);
    expect(refused.searched).toBe(false);
    await assertRecorded(
      refused.metrics,
      `bx402_payment_failures_total{rail="x402",step="verify",reason="${failure.INVALID_PAYMENT}"} 1`,
    );

    // Radius's testnet facilitator answers 502 right after it restarts.
    const down = await verifyAnswering(502, { error: "bad gateway" });
    expect(down.response.status).toBe(502);
    expect(down.searched).toBe(false);
    await assertRecorded(
      down.metrics,
      `bx402_payments_total{rail="x402",endpoint="${PATH}",outcome="network_unavailable"} 1`,
    );
  });

  it("a_radius_payment_cannot_name_its_own_price_or_token", async () => {
    mockFacilitatorSupport();
    mockRadiusSupport();
    const built = await start(RADIUS_ON, true);
    const offer = offerOn(RADIUS_TESTNET);
    const refuse = async (accepted: object) => {
      let searched = false;
      const response = await handle(
        built,
        undefined,
        new Metrics(),
        PATH,
        REQUESTED,
        payment(accepted),
        async () => {
          searched = true;
          return SEARCH_RESULT();
        },
      );
      return { status: response.status, searched };
    };
    for (const accepted of [
      { ...offer, amount: "1" },
      { ...offer, payTo: `0x${"11".repeat(20)}` },
      { ...offer, asset: `0x${"22".repeat(20)}` },
      // A network we never advertised, whatever the rest of the offer says.
      { ...offer, network: "eip155:1" },
    ]) {
      expect(await refuse(accepted), JSON.stringify(accepted)).toEqual({
        status: 402,
        searched: false,
      });
    }

    const without = client({ ...RADIUS_ON, enableRadius: false }, true);
    const response = await handle(
      without,
      undefined,
      new Metrics(),
      PATH,
      REQUESTED,
      payment(offer),
      async () => SEARCH_RESULT(),
    );
    expect(response.status).toBe(402);
  });

  it("a_permit2_payload_is_still_refused_before_any_facilitator_call", async () => {
    // The offer is an eip3009 transfer, so a payload that carries a Permit2 permit
    // instead of an authorization has no payer for the rail to screen.
    mockFacilitatorSupport();
    mockRadiusSupport();
    const built = await start(RADIUS_ON, true);
    const headers = new Headers({
      "payment-signature": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: offerOn(RADIUS_TESTNET),
          payload: { permit2Authorization: { from: `0x${"AB".repeat(20)}` }, signature: "0x" },
        }),
      ).toString("base64"),
    });
    const response = await handle(built, undefined, new Metrics(), PATH, REQUESTED, headers, () =>
      Promise.reject(new Error("no search for a payment that does not decode")),
    );
    expect(response.status).toBe(402);
  });

  it("startup_stops_when_a_radius_facilitator_cannot_say_it_supports_its_network", async () => {
    // The resource server skips a facilitator it cannot reach while another answers,
    // so without this check Radius would be advertised behind a Base facilitator that
    // is up and every Radius payment would fail.
    mockFacilitatorSupport();
    mockOrigin(RADIUS_MAINNET_FACILITATOR)
      .intercept({ method: "GET", path: "/supported" })
      .reply(200, { kinds: [], extensions: [], signers: {} });
    mockOrigin(RADIUS_TESTNET_FACILITATOR)
      .intercept({ method: "GET", path: "/supported" })
      .reply(502, "bad gateway");

    await expect(start(RADIUS_ON, true)).rejects.toThrow(
      `X402_ENABLE_RADIUS: the Radius facilitator ${RADIUS_TESTNET_FACILITATOR} did not report supporting exact payments on ${RADIUS_TESTNET}`,
    );
    restoreNetwork();

    // Without the testnet, only mainnet is sold, so only mainnet has to answer.
    mockFacilitatorSupport();
    mockOrigin(RADIUS_MAINNET_FACILITATOR)
      .intercept({ method: "GET", path: "/supported" })
      .reply(200, { kinds: [], extensions: [], signers: {} });
    await expect(start(RADIUS_ON, false)).rejects.toThrow(RADIUS_MAINNET);
  });

  it("a_deployment_without_radius_never_calls_a_radius_facilitator", async () => {
    // No stub for either Radius origin: a call to one would fail the start.
    mockFacilitatorSupport();
    const built = await start({ ...RADIUS_ON, enableRadius: false }, true);
    expect(built.accepts.get(PATH)?.map((entry) => entry.network)).toEqual([
      "eip155:84532",
      "eip155:8453",
    ]);
  });
});
