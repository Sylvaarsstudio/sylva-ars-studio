import { Buffer } from "node:buffer";

const EASYPOST_SHIPMENTS_ENDPOINT = "https://api.easypost.com/v2/shipments";
const DEFAULT_TIMEOUT_MS = 9000;

class ShippingRateProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "ShippingRateProviderError";
    this.code = code;
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "")
  );
}

function mapAddress(address, nameField) {
  return compactObject({
    name: address[nameField],
    street1: address.address_line1,
    street2: address.address_line2,
    city: address.city,
    state: address.state_region,
    zip: address.postal_code,
    country: address.country
  });
}

function poundsToOunces(weightPounds) {
  const ounces = Number((Number(weightPounds) * 16).toFixed(1));
  if (!Number.isFinite(ounces) || ounces <= 0) {
    throw new ShippingRateProviderError("invalid_parcel");
  }
  return ounces;
}

function buildEasyPostShipmentPayload({ origin, destination, parcel }) {
  return {
    shipment: {
      from_address: mapAddress(origin, "name"),
      to_address: mapAddress(destination, "recipient_name"),
      parcel: {
        length: parcel.length,
        width: parcel.width,
        height: parcel.height,
        weight: poundsToOunces(parcel.weight)
      }
    }
  };
}

function normalizeEasyPostRate(rate, now) {
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) return null;
  const rateId = String(rate.id ?? "").trim();
  const carrier = String(rate.carrier ?? "").trim();
  const service = String(rate.service ?? "").trim();
  const currency = String(rate.currency ?? "").trim().toUpperCase();
  const amount = Number(rate.rate);
  if (!rateId || !carrier || !service || !Number.isFinite(amount) || amount <= 0) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;

  let estimatedDays = null;
  if (rate.delivery_days !== null && rate.delivery_days !== undefined) {
    const days = Number(rate.delivery_days);
    if (Number.isInteger(days) && days > 0 && days <= 365) estimatedDays = days;
  }
  const providerTimestamp = typeof rate.created_at === "string" && rate.created_at.trim()
    ? new Date(rate.created_at)
    : null;
  const fallbackTimestamp = now();
  const generatedAt = !providerTimestamp || Number.isNaN(providerTimestamp.getTime())
    ? fallbackTimestamp.toISOString()
    : providerTimestamp.toISOString();

  return {
    provider: "easypost",
    carrier,
    service,
    amount: amount.toFixed(2),
    currency,
    estimated_days: estimatedDays,
    rate_id: rateId,
    generated_at: generatedAt,
    expires_at: null
  };
}

function providerErrorText(body) {
  const error = body?.error;
  const parts = [error?.code, error?.message];
  if (Array.isArray(error?.errors)) {
    for (const item of error.errors) {
      if (typeof item === "string") parts.push(item);
      else parts.push(item?.code, item?.field, item?.message);
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function classifyProviderFailure(status, body) {
  if (status === 401 || status === 403) return "provider_authentication_failed";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_unavailable";
  const detail = providerErrorText(body);
  if (/address|street|city|state|postal|zip/.test(detail)) {
    return "invalid_shipping_address";
  }
  if (/parcel|weight|length|width|height/.test(detail)) return "invalid_parcel";
  return "shipping_rate_error";
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function createEasyPostRateProvider({
  apiKey,
  fetchImplementation = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date()
} = {}) {
  if (!String(apiKey ?? "").trim()) return null;
  if (typeof fetchImplementation !== "function") {
    throw new ShippingRateProviderError("provider_unavailable");
  }
  return {
    async getShippingRates(context) {
      if (String(context.destination.country).trim().toUpperCase() !== "US") {
        throw new ShippingRateProviderError("international_shipping_not_supported_yet");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImplementation(EASYPOST_SHIPMENTS_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildEasyPostShipmentPayload(context)),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          throw new ShippingRateProviderError("provider_unavailable");
        }
        throw new ShippingRateProviderError("provider_unavailable");
      } finally {
        clearTimeout(timeout);
      }

      const body = await safeJson(response);
      if (!response.ok) {
        throw new ShippingRateProviderError(classifyProviderFailure(response.status, body));
      }
      if (!body || !Array.isArray(body.rates)) {
        throw new ShippingRateProviderError("shipping_rate_error");
      }
      const rates = body.rates
        .map((rate) => normalizeEasyPostRate(rate, now))
        .filter(Boolean)
        .sort((left, right) => Number(left.amount) - Number(right.amount)
          || left.carrier.localeCompare(right.carrier)
          || left.service.localeCompare(right.service));
      if (!rates.length) throw new ShippingRateProviderError("no_rates_available");
      return rates;
    }
  };
}

export {
  DEFAULT_TIMEOUT_MS,
  EASYPOST_SHIPMENTS_ENDPOINT,
  ShippingRateProviderError,
  buildEasyPostShipmentPayload,
  classifyProviderFailure,
  createEasyPostRateProvider,
  normalizeEasyPostRate,
  poundsToOunces
};
