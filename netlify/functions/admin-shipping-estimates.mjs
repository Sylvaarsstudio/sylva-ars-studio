import { hasValidAdminSession } from "../shared/admin-session.mjs";
import {
  createEasyPostRateProvider,
  ShippingRateProviderError
} from "../shared/easypost-rate-provider.mjs";
import {
  getShippingRates,
  normalizeShippingEstimateRequest,
  readShippingOrigin
} from "../shared/shipping-rates.mjs";

const ENDPOINT_PATH = "/admin/api/shipping/estimate";

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function readEnvironmentVariable(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
}

function logFailure(error) {
  console.error("Admin shipping estimate request failed.", {
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

const providerErrors = Object.freeze({
  international_shipping_not_supported_yet: [
    422, "International shipping rates are not supported yet."
  ],
  invalid_shipping_address: [422, "The shipping address could not be rated."],
  invalid_parcel: [422, "The parcel could not be rated."],
  provider_authentication_failed: [502, "The shipping rate provider could not authenticate."],
  provider_rate_limit: [503, "The shipping rate provider is temporarily rate limited."],
  provider_unavailable: [503, "The shipping rate provider is currently unavailable."],
  no_rates_available: [422, "No shipping rates are available for this shipment."],
  shipping_rate_error: [502, "The shipping rate request could not be completed."]
});

function providerErrorResponse(code) {
  const [status, message] = providerErrors[code] || providerErrors.shipping_rate_error;
  return jsonResponse(status, { success: false, code, message });
}

function createHandler({
  environmentReader = readEnvironmentVariable,
  rateProvider = null,
  fetchImplementation = globalThis.fetch,
  providerTimeoutMs
} = {}) {
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;
    if (!adminPassword) {
      return jsonResponse(500, {
        success: false,
        code: "admin_auth_not_configured",
        message: "Admin authentication is not configured."
      });
    }
    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, {
        success: false,
        code: "unauthorized",
        message: "Unauthorized."
      });
    }
    if (new URL(request.url).pathname !== ENDPOINT_PATH) {
      return jsonResponse(404, {
        success: false,
        code: "not_found",
        message: "Admin endpoint not found."
      });
    }
    if (request.method !== "POST") {
      return jsonResponse(405, {
        success: false,
        code: "method_not_allowed",
        message: "Method not allowed. Use POST."
      });
    }
    const normalized = normalizeShippingEstimateRequest(
      await request.json().catch(() => null)
    );
    if (normalized.error) {
      return jsonResponse(400, {
        success: false,
        code: "invalid_shipping_estimate_request",
        message: normalized.error
      });
    }
    const originConfiguration = readShippingOrigin(environmentReader);
    if (!originConfiguration.configured) {
      return jsonResponse(503, {
        success: false,
        code: "shipping_origin_not_configured",
        message: "Shipping origin is not configured."
      });
    }
    if (normalized.value.destination.country.toUpperCase() !== "US") {
      return providerErrorResponse("international_shipping_not_supported_yet");
    }
    try {
      const configuredProvider = rateProvider || createEasyPostRateProvider({
        apiKey: environmentReader("EASYPOST_API_KEY"),
        fetchImplementation,
        timeoutMs: providerTimeoutMs
      });
      const result = await getShippingRates({
        origin: originConfiguration.origin,
        destination: normalized.value.destination,
        parcel: normalized.value.parcel
      }, configuredProvider);
      if (result.outcome === "rate_provider_not_configured") {
        return jsonResponse(503, {
          success: false,
          code: "rate_provider_not_configured",
          message: "Live shipping rates are not configured yet."
        });
      }
      if (result.outcome !== "success") {
        return providerErrorResponse("shipping_rate_error");
      }
      if (!result.rates.length) {
        return providerErrorResponse("no_rates_available");
      }
      return jsonResponse(200, {
        success: true,
        destination: normalized.value.destination,
        parcel: normalized.value.parcel,
        rates: result.rates
      });
    } catch (error) {
      logFailure(error);
      if (error instanceof ShippingRateProviderError) {
        return providerErrorResponse(error.code);
      }
      return providerErrorResponse("provider_unavailable");
    }
  };
}

export const config = { path: ENDPOINT_PATH };

export {
  createHandler,
  ENDPOINT_PATH,
  providerErrorResponse
};

export default createHandler();
