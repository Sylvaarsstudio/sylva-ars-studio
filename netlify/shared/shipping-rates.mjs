const originEnvironmentFields = Object.freeze({
  name: "SHIPPING_ORIGIN_NAME",
  address_line1: "SHIPPING_ORIGIN_ADDRESS1",
  address_line2: "SHIPPING_ORIGIN_ADDRESS2",
  city: "SHIPPING_ORIGIN_CITY",
  state_region: "SHIPPING_ORIGIN_STATE",
  postal_code: "SHIPPING_ORIGIN_POSTAL_CODE",
  country: "SHIPPING_ORIGIN_COUNTRY"
});

const destinationFields = new Set([
  "recipient_name", "address_line1", "address_line2", "city",
  "state_region", "postal_code", "country"
]);
const parcelFields = new Set([
  "length", "width", "height", "dimension_unit", "weight", "weight_unit"
]);
const rateFields = new Set([
  "provider", "carrier", "service", "amount", "currency",
  "estimated_days", "rate_id", "generated_at", "expires_at"
]);
const snapshotFields = new Set([
  "provider", "carrier", "service", "estimated_amount", "currency",
  "estimated_days", "rate_id", "generated_at", "parcel", "destination"
]);
const snapshotDestinationFields = new Set([
  "city", "state_region", "postal_code", "country"
]);
const maximumDimensionInches = 200;
const maximumWeightPounds = 500;

function normalizeText(value, label, { required = true, maximum = 200 } = {}) {
  const normalized = value === null || value === undefined ? "" : String(value).trim();
  if (!normalized) {
    return required ? { error: `${label} is required.` } : { value: null };
  }
  if (normalized.length > maximum) return { error: `${label} is too long.` };
  return { value: normalized };
}

function rejectUnexpectedFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${label} must be an object.`;
  }
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  return unexpected ? `${label} contains unsupported field: ${unexpected}.` : null;
}

function normalizePositiveNumber(value, label, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > maximum) {
    return { error: `${label} must be greater than 0 and no more than ${maximum}.` };
  }
  return { value: Number(number.toFixed(2)) };
}

function normalizeMoney(value, label = "Rate amount") {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { error: `${label} must be a non-negative monetary amount.` };
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 999999999999) {
    return { error: `${label} is outside the supported range.` };
  }
  return { value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}

function normalizeTimestamp(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) {
    return { value: null };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${label} must be a valid timestamp.` };
  return { value: date.toISOString() };
}

function readShippingOrigin(environmentReader) {
  const origin = {};
  const missing = [];
  for (const [field, variable] of Object.entries(originEnvironmentFields)) {
    const required = field !== "address_line2";
    const normalized = normalizeText(environmentReader(variable), variable, { required });
    if (normalized.error) {
      if (required) missing.push(variable);
      origin[field] = null;
    } else {
      origin[field] = normalized.value;
    }
  }
  return missing.length
    ? { configured: false, missing, origin: null }
    : { configured: true, missing: [], origin };
}

function normalizeDestination(value) {
  const fieldError = rejectUnexpectedFields(value, destinationFields, "Destination");
  if (fieldError) return { error: fieldError };
  const destination = {};
  for (const [field, label, required] of [
    ["recipient_name", "Recipient name", false],
    ["address_line1", "Address line 1", true],
    ["address_line2", "Address line 2", false],
    ["city", "City", true],
    ["state_region", "State / region", true],
    ["postal_code", "Postal code", true],
    ["country", "Country", true]
  ]) {
    const normalized = normalizeText(value[field], label, { required });
    if (normalized.error) return normalized;
    destination[field] = normalized.value;
  }
  return { value: destination };
}

function normalizeParcel(value) {
  const fieldError = rejectUnexpectedFields(value, parcelFields, "Parcel");
  if (fieldError) return { error: fieldError };
  if (value.dimension_unit !== "in") {
    return { error: "Dimension unit must be in." };
  }
  if (value.weight_unit !== "lb") {
    return { error: "Weight unit must be lb." };
  }
  const parcel = { dimension_unit: "in", weight_unit: "lb" };
  for (const [field, label, maximum] of [
    ["length", "Parcel length", maximumDimensionInches],
    ["width", "Parcel width", maximumDimensionInches],
    ["height", "Parcel height", maximumDimensionInches],
    ["weight", "Parcel weight", maximumWeightPounds]
  ]) {
    const normalized = normalizePositiveNumber(value[field], label, maximum);
    if (normalized.error) return normalized;
    parcel[field] = normalized.value;
  }
  return { value: parcel };
}

function normalizeSnapshotDestination(value) {
  const fieldError = rejectUnexpectedFields(
    value,
    snapshotDestinationFields,
    "Shipping estimate destination"
  );
  if (fieldError) return { error: fieldError };
  const destination = {};
  for (const [field, label] of [
    ["city", "City"],
    ["state_region", "State / region"],
    ["postal_code", "Postal code"],
    ["country", "Country"]
  ]) {
    const normalized = normalizeText(value[field], label);
    if (normalized.error) return normalized;
    destination[field] = normalized.value;
  }
  return { value: destination };
}

function normalizeShippingEstimateRequest(value) {
  const fieldError = rejectUnexpectedFields(
    value,
    new Set(["destination", "parcel"]),
    "Request body"
  );
  if (fieldError) return { error: fieldError };
  const destination = normalizeDestination(value.destination);
  if (destination.error) return destination;
  const parcel = normalizeParcel(value.parcel);
  if (parcel.error) return parcel;
  return { value: { destination: destination.value, parcel: parcel.value } };
}

function normalizeRate(value) {
  const fieldError = rejectUnexpectedFields(value, rateFields, "Shipping rate");
  if (fieldError) return { error: fieldError };
  const rate = {};
  for (const [field, label] of [
    ["provider", "Rate provider"],
    ["carrier", "Carrier"],
    ["service", "Service level"],
    ["rate_id", "Rate id"]
  ]) {
    const normalized = normalizeText(value[field], label);
    if (normalized.error) return normalized;
    rate[field] = normalized.value;
  }
  const amount = normalizeMoney(value.amount);
  if (amount.error) return amount;
  rate.amount = amount.value;
  const currency = normalizeText(value.currency, "Currency");
  if (currency.error || !/^[A-Za-z]{3}$/.test(currency.value)) {
    return { error: "Currency must be a three-letter code." };
  }
  rate.currency = currency.value.toUpperCase();
  if (value.estimated_days === null || value.estimated_days === undefined) {
    rate.estimated_days = null;
  } else if (!Number.isInteger(Number(value.estimated_days))
    || Number(value.estimated_days) < 1
    || Number(value.estimated_days) > 365) {
    return { error: "Estimated transit time must be between 1 and 365 days." };
  } else {
    rate.estimated_days = Number(value.estimated_days);
  }
  const generatedAt = normalizeTimestamp(value.generated_at, "Generated at");
  if (generatedAt.error) return generatedAt;
  const expiresAt = normalizeTimestamp(value.expires_at, "Expires at", { nullable: true });
  if (expiresAt.error) return expiresAt;
  rate.generated_at = generatedAt.value;
  rate.expires_at = expiresAt.value;
  return { value: rate };
}

async function getShippingRates({ origin, destination, parcel }, rateProvider = null) {
  if (!rateProvider || typeof rateProvider.getShippingRates !== "function") {
    return { outcome: "rate_provider_not_configured", rates: [] };
  }
  const provided = await rateProvider.getShippingRates({ origin, destination, parcel });
  const rawRates = Array.isArray(provided) ? provided : provided?.rates;
  if (!Array.isArray(rawRates)) {
    return { outcome: "invalid_provider_response", rates: [] };
  }
  const rates = [];
  for (const rawRate of rawRates) {
    const normalized = normalizeRate(rawRate);
    if (normalized.error) {
      return { outcome: "invalid_provider_response", rates: [], error: normalized.error };
    }
    rates.push(normalized.value);
  }
  return { outcome: "success", rates };
}

function buildShippingEstimateSnapshot(rate, destination, parcel) {
  const normalizedRate = normalizeRate(rate);
  if (normalizedRate.error) return normalizedRate;
  const normalizedDestination = normalizeDestination(destination);
  if (normalizedDestination.error) return normalizedDestination;
  const normalizedParcel = normalizeParcel(parcel);
  if (normalizedParcel.error) return normalizedParcel;
  return {
    value: {
      provider: normalizedRate.value.provider,
      carrier: normalizedRate.value.carrier,
      service: normalizedRate.value.service,
      estimated_amount: normalizedRate.value.amount,
      currency: normalizedRate.value.currency,
      estimated_days: normalizedRate.value.estimated_days,
      rate_id: normalizedRate.value.rate_id,
      generated_at: normalizedRate.value.generated_at,
      parcel: normalizedParcel.value,
      destination: {
        city: normalizedDestination.value.city,
        state_region: normalizedDestination.value.state_region,
        postal_code: normalizedDestination.value.postal_code,
        country: normalizedDestination.value.country
      }
    }
  };
}

function normalizeShippingEstimateSnapshot(value) {
  if (value === null) return { value: null };
  const fieldError = rejectUnexpectedFields(value, snapshotFields, "Shipping estimate snapshot");
  if (fieldError) return { error: fieldError };
  const destination = normalizeSnapshotDestination(value.destination);
  if (destination.error) return destination;
  const parcel = normalizeParcel(value.parcel);
  if (parcel.error) return parcel;
  const rate = normalizeRate({
    provider: value.provider,
    carrier: value.carrier,
    service: value.service,
    amount: value.estimated_amount,
    currency: value.currency,
    estimated_days: value.estimated_days,
    rate_id: value.rate_id,
    generated_at: value.generated_at,
    expires_at: null
  });
  if (rate.error) return rate;
  return {
    value: {
      provider: rate.value.provider,
      carrier: rate.value.carrier,
      service: rate.value.service,
      estimated_amount: rate.value.amount,
      currency: rate.value.currency,
      estimated_days: rate.value.estimated_days,
      rate_id: rate.value.rate_id,
      generated_at: rate.value.generated_at,
      parcel: parcel.value,
      destination: destination.value
    }
  };
}

export {
  buildShippingEstimateSnapshot,
  getShippingRates,
  maximumDimensionInches,
  maximumWeightPounds,
  normalizeDestination,
  normalizeParcel,
  normalizeRate,
  normalizeSnapshotDestination,
  normalizeShippingEstimateRequest,
  normalizeShippingEstimateSnapshot,
  originEnvironmentFields,
  readShippingOrigin
};
